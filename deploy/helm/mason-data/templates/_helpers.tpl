{{- define "mason.name" -}}
{{ .Release.Name }}
{{- end -}}

{{- define "mason.labels" -}}
app: {{ include "mason.name" . }}
app.kubernetes.io/name: mason-data
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "mason.secretName" -}}
{{ .Values.database.existingSecret | default (printf "%s-database" (include "mason.name" .)) }}
{{- end -}}
