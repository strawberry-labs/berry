{{- define "berry-platform.name" -}}
berry-platform
{{- end -}}

{{- define "berry-platform.labels" -}}
app.kubernetes.io/name: {{ include "berry-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "berry-platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "berry-platform.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
