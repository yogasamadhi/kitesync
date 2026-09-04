package main

import (
	"debug/buildinfo"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime/debug"
	"sort"
	"strings"
)

type moduleIdentity struct {
	Path        string          `json:"path"`
	Version     string          `json:"version"`
	Sum         string          `json:"sum"`
	Replacement *moduleIdentity `json:"replacement"`
	Targets     []string        `json:"targets"`
}

type inventorySource struct {
	Module     string   `json:"module"`
	CGOEnabled bool     `json:"cgoEnabled"`
	BuildTags  []string `json:"buildTags"`
}

type inventoryDocument struct {
	Source  inventorySource  `json:"source"`
	Modules []moduleIdentity `json:"modules"`
}

func main() {
	if len(os.Args) != 3 {
		fatalf("usage: go run scripts/verify-syncthing-modules.go <GO_MODULES.json> <syncthing>")
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fatalf("read Go module inventory: %v", err)
	}
	var inventory inventoryDocument
	if err := json.Unmarshal(data, &inventory); err != nil {
		fatalf("parse Go module inventory: %v", err)
	}
	info, err := buildinfo.ReadFile(os.Args[2])
	if err != nil {
		fatalf("read Go build info from %s: %v", os.Args[2], err)
	}
	if info.Path != inventory.Source.Module+"/cmd/syncthing" {
		fatalf("unexpected Go main package %q", info.Path)
	}

	settings := make(map[string]string, len(info.Settings))
	for _, setting := range info.Settings {
		settings[setting.Key] = setting.Value
	}
	target := settings["GOOS"] + "-" + settings["GOARCH"]
	if target == "-" {
		fatalf("Syncthing build info is missing GOOS/GOARCH")
	}
	expectedCGO := "0"
	if inventory.Source.CGOEnabled {
		expectedCGO = "1"
	}
	if settings["CGO_ENABLED"] != expectedCGO {
		fatalf("Syncthing CGO_ENABLED=%q, expected %s", settings["CGO_ENABLED"], expectedCGO)
	}
	actualTags := splitTags(settings["-tags"])
	expectedTags := append([]string(nil), inventory.Source.BuildTags...)
	sort.Strings(expectedTags)
	if strings.Join(actualTags, "\x00") != strings.Join(expectedTags, "\x00") {
		fatalf("Syncthing build tags %v do not match inventory %v", actualTags, expectedTags)
	}

	inventoryByPath := make(map[string]moduleIdentity, len(inventory.Modules))
	expectedForTarget := make(map[string]moduleIdentity)
	for _, module := range inventory.Modules {
		if module.Path == "" || module.Version == "" {
			fatalf("Go module inventory contains an empty path or version")
		}
		if _, duplicate := inventoryByPath[module.Path]; duplicate {
			fatalf("Go module inventory contains duplicate %s", module.Path)
		}
		inventoryByPath[module.Path] = module
		if contains(module.Targets, target) {
			expectedForTarget[module.Path] = module
		}
	}

	actualForTarget := make(map[string]bool, len(info.Deps))
	for _, dependency := range info.Deps {
		expected, ok := inventoryByPath[dependency.Path]
		if !ok {
			fatalf("binary contains Go module absent from inventory: %s@%s", dependency.Path, dependency.Version)
		}
		if _, expectedOnTarget := expectedForTarget[dependency.Path]; !expectedOnTarget {
			fatalf("binary contains %s, but inventory does not assign it to %s", dependency.Path, target)
		}
		if err := compareModule(expected, dependency); err != nil {
			fatalf("%s: %v", dependency.Path, err)
		}
		actualForTarget[dependency.Path] = true
	}
	missing := make([]string, 0)
	for path := range expectedForTarget {
		if !actualForTarget[path] {
			missing = append(missing, path)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		fatalf("binary is missing inventory modules for %s: %s", target, strings.Join(missing, ", "))
	}
	fmt.Printf("Verified %d Go modules in %s for %s\n", len(info.Deps), os.Args[2], target)
}

func compareModule(expected moduleIdentity, actual *debug.Module) error {
	if actual.Version != expected.Version {
		return fmt.Errorf("version %q does not match inventory %q", actual.Version, expected.Version)
	}
	if expected.Sum != "" && actual.Sum != expected.Sum {
		return fmt.Errorf("sum %q does not match inventory %q", actual.Sum, expected.Sum)
	}
	if (expected.Replacement == nil) != (actual.Replace == nil) {
		return errors.New("replacement presence does not match inventory")
	}
	if expected.Replacement != nil {
		if actual.Replace.Path != expected.Replacement.Path || actual.Replace.Version != expected.Replacement.Version {
			return fmt.Errorf(
				"replacement %s@%s does not match inventory %s@%s",
				actual.Replace.Path,
				actual.Replace.Version,
				expected.Replacement.Path,
				expected.Replacement.Version,
			)
		}
		if expected.Replacement.Sum != "" && actual.Replace.Sum != expected.Replacement.Sum {
			return fmt.Errorf("replacement sum %q does not match inventory %q", actual.Replace.Sum, expected.Replacement.Sum)
		}
	}
	return nil
}

func splitTags(value string) []string {
	fields := strings.FieldsFunc(value, func(character rune) bool {
		return character == ',' || character == ' '
	})
	sort.Strings(fields)
	return fields
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func fatalf(format string, values ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", values...)
	os.Exit(1)
}
