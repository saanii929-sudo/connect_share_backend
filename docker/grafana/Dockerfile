FROM grafana/grafana:10.4.2

# Bake provisioning files into the image so Coolify doesn't need host mounts.
COPY provisioning/datasources/prometheus.yml /etc/grafana/provisioning/datasources/prometheus.yml
COPY provisioning/dashboards/dashboard.yml   /etc/grafana/provisioning/dashboards/dashboard.yml
COPY provisioning/dashboards/connectshare.json /etc/grafana/provisioning/dashboards/connectshare.json
