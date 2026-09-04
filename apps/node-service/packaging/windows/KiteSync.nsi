Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"

!ifndef STAGE
  !error "STAGE is required"
!endif
!ifndef OUTPUT
  !error "OUTPUT is required"
!endif
!ifndef VERSION
  !define VERSION "1.0.0"
!endif

Name "KiteSync"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\KiteSync"
InstallDirRegKey HKCU "Software\KiteSync" "InstallDir"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\kitesync.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "open"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "KiteSync" SecMain
  SetShellVarContext current
  ; Stop an installed native task before replacing its executable. A previous Electron build
  ; used the same product name, so also terminate that exact per-user image and remove only its
  ; KiteSync login value. State under AppData is deliberately left untouched.
  IfFileExists "$INSTDIR\service-task.ps1" 0 native_task_stopped
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\service-task.ps1" -Remove'
    Pop $0
    StrCmp $0 "0" native_task_stopped
    Abort "无法停止现有 KiteSync 后台任务（退出码 $0），安装已取消。"
  native_task_stopped:
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "KiteSync"
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "KiteSync.exe" /T /F'
  Pop $0
  Sleep 1000
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\KiteSync" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KiteSync" "DisplayName" "KiteSync"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KiteSync" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KiteSync" "Publisher" "KiteSync"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KiteSync" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KiteSync" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KiteSync" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\KiteSync"
  CreateShortcut "$SMPROGRAMS\KiteSync\打开 KiteSync.lnk" "$INSTDIR\kitesync.exe" "open"
  CreateShortcut "$DESKTOP\KiteSync.lnk" "$INSTDIR\kitesync.exe" "open"
  CreateShortcut "$SMPROGRAMS\KiteSync\卸载 KiteSync.lnk" "$INSTDIR\Uninstall.exe"
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\service-task.ps1" -Executable "$INSTDIR\kitesync.exe"'
  Pop $0
  StrCmp $0 "0" service_task_installed
    Abort "无法安装 KiteSync 登录自启动任务（退出码 $0）。"
  service_task_installed:
  ClearErrors
  ExecShellWait "runas" "powershell.exe" '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\firewall.ps1" -Syncthing "$INSTDIR\syncthing.exe"'
  IfErrors firewall_install_failed
  StrCmp $0 "0" firewall_installed
  firewall_install_failed:
    DetailPrint "未能添加 Private Network 防火墙规则；请在 Windows 安全中心手工允许 Syncthing。"
    IfSilent firewall_installed
    MessageBox MB_ICONEXCLAMATION|MB_OK "KiteSync 已安装，但未能添加 Private Network 防火墙规则。请在 Windows 安全中心手工允许 Syncthing。"
  firewall_installed:
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\service-task.ps1" -Remove'
  Pop $0
  StrCmp $0 "0" uninstall_task_removed
    DetailPrint "未能移除 KiteSync 登录任务（退出码 $0）。"
  uninstall_task_removed:
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /IM "KiteSync.exe" /T /F'
  Pop $0
  Sleep 1000
  ClearErrors
  ExecShellWait "runas" "powershell.exe" '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\firewall.ps1" -Remove'
  IfErrors firewall_remove_failed
  StrCmp $0 "0" firewall_removed
  firewall_remove_failed:
    DetailPrint "未能移除 KiteSync 防火墙规则；可在 Windows 安全中心手工删除 KiteSync 规则组。"
    IfSilent firewall_removed
    MessageBox MB_ICONEXCLAMATION|MB_OK "未能自动移除 KiteSync 防火墙规则。可在 Windows 安全中心手工删除 KiteSync 规则组。"
  firewall_removed:
  Delete "$DESKTOP\KiteSync.lnk"
  RMDir /r "$SMPROGRAMS\KiteSync"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KiteSync"
  DeleteRegKey HKCU "Software\KiteSync"
  Delete "$INSTDIR\kitesync.exe"
  Delete "$INSTDIR\syncthing.exe"
  Delete "$INSTDIR\service-task.ps1"
  Delete "$INSTDIR\firewall.ps1"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.txt"
  Delete "$INSTDIR\SYNCTHING_NOTICE.txt"
  Delete "$INSTDIR\SYNCTHING_LICENSE.txt"
  Delete "$INSTDIR\SYNCTHING_GO_MODULES.json"
  Delete "$INSTDIR\SYNCTHING_BUILD.json"
  Delete "$INSTDIR\Uninstall.exe"
  ; Only remove an empty program directory. Unknown files and all AppData state survive.
  RMDir "$INSTDIR"
  ; 用户的本地状态、Syncthing 配置和同步目录默认保留。
SectionEnd
