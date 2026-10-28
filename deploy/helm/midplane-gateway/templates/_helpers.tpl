{{/* The release's name, which names the StatefulSet, its pod and its disk. */}}
{{- define "midplane-gateway.name" -}}
{{- .Release.Name | trunc 52 | trimSuffix "-" -}}
{{- end -}}

{{- define "midplane-gateway.selector" -}}
app.kubernetes.io/name: midplane-gateway
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "midplane-gateway.labels" -}}
{{ include "midplane-gateway.selector" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
