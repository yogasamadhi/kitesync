{{- define "kitesync.name" -}}kitesync{{- end }}
{{- define "kitesync.labels" -}}
app.kubernetes.io/name: kitesync
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
{{- define "kitesync.databaseUrl" -}}
{{- if .Values.postgresql.internal -}}
postgres://{{ .Values.postgresql.username }}:{{ .Values.postgresql.password }}@kitesync-postgresql:5432/{{ .Values.postgresql.database }}
{{- else -}}
{{ required "postgresql.externalUrl is required when internal=false" .Values.postgresql.externalUrl }}
{{- end -}}
{{- end }}
