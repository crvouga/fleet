# The fleet-enroll workflow may read a role's secrets (its age key and its fleet
# API token) only as a Vault response-wrapped token: min_wrapping_ttl makes Vault
# refuse an unwrapped read, so the workflow never holds the raw values. The new
# node unwraps them once.
path "secret/data/fleet/+" {
  capabilities     = ["read"]
  min_wrapping_ttl = "5m"
  max_wrapping_ttl = "1h"
}
