FROM prom/prometheus:v2.52.0

# Bake the config and alert rules directly into the image.
# This avoids host-path volume mounts, which don't work on Coolify
# (the monitoring/ directory only exists in the repo, not on the Coolify host).
COPY prometheus.yml /etc/prometheus/prometheus.yml
COPY alerts.yml     /etc/prometheus/rules/alerts.yml
