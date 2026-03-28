# TOON Oyster CVM -- Nix Reproducible Docker Image Expression
#
# This is a Nix expression (NOT a traditional Dockerfile) that produces a
# deterministic Docker image via `dockerTools.buildLayeredImage`. Every byte
# of the output is derived from content-addressed inputs in the Nix store,
# ensuring that two independent builds from the same source tree produce
# identical Docker image hashes and thus identical PCR (Platform Configuration
# Register) values for TEE attestation verification.
#
# Reproducibility Constraints (FR-TEE-5):
#   - All package inputs come from a pinned nixpkgs commit (via flake.lock)
#   - No mutable package managers (no apt-get, no npm install, no pip install)
#   - No unpinned base images (no FROM, no :latest tags)
#   - No git clones without pinned commits
#   - No remote script execution (no curl | bash)
#   - Timestamps are fixed to epoch 0 for layer reproducibility
#
# This file is consumed by the flake.nix at the project root:
#   nix build .#docker-image
#
# The resulting image contains the same runtime components as Dockerfile.oyster:
#   - Node.js 20 runtime
#   - supervisord for multi-process orchestration
#   - Non-root toon user (uid 1001, gid 1001)
#   - Ports: 3100 (BLS HTTP), 7100 (Nostr Relay WS), 1300 (Attestation HTTP)
#   - CMD: supervisord -c /etc/supervisord.conf
#
# Usage (from flake.nix):
#   nix build .#docker-image
#   docker load < result
#
{ pkgs, productionDeps }:

let
  # Non-root user for security (matching Dockerfile.oyster uid/gid 1001)
  toon-user = pkgs.runCommand "toon-user" { } ''
    mkdir -p $out/etc
    echo "root:x:0:0:root:/root:/bin/sh" > $out/etc/passwd
    echo "toon:x:1001:1001:toon:/app:/bin/sh" >> $out/etc/passwd
    echo "root:x:0:" > $out/etc/group
    echo "toon:x:1001:" >> $out/etc/group
    echo "root:x:!:1::::::" > $out/etc/shadow
    echo "toon:x:!:1::::::" >> $out/etc/shadow
  '';

  # Supervisord configuration (copied from docker/supervisord.conf)
  supervisord-conf = pkgs.runCommand "supervisord-conf" { } ''
    mkdir -p $out/etc
    cat > $out/etc/supervisord.conf << 'SUPERVISOR_EOF'
    [supervisord]
    nodaemon=true
    user=root

    [program:toon]
    priority=10
    command=node /app/dist/entrypoint-sdk.js
    user=toon
    autorestart=true
    stopwaitsecs=15
    stdout_logfile=/dev/stdout
    stdout_logfile_maxbytes=0
    stderr_logfile=/dev/stderr
    stderr_logfile_maxbytes=0

    [program:attestation]
    priority=20
    command=node /app/dist/attestation-server.js
    user=toon
    autorestart=true
    startsecs=5
    stopwaitsecs=10
    stdout_logfile=/dev/stdout
    stdout_logfile_maxbytes=0
    stderr_logfile=/dev/stderr
    stderr_logfile_maxbytes=0
    SUPERVISOR_EOF
  '';

  # Application directory structure
  app-dir = pkgs.runCommand "toon-app" { } ''
    mkdir -p $out/app
    cp -r ${productionDeps}/* $out/app/
    mkdir -p $out/data
  '';

in
pkgs.dockerTools.buildLayeredImage {
  name = "toon";
  tag = "nix";

  # Fixed creation timestamp for reproducibility -- epoch 0 ensures no
  # timestamp-based non-determinism in the image metadata
  created = "1970-01-01T00:00:00Z";

  contents = [
    # Runtime: Node.js 20 (pinned via nixpkgs commit in flake.lock)
    pkgs.nodejs_20

    # Process orchestration: supervisord for Oyster CVM multi-process management
    pkgs.python3Packages.supervisor

    # Minimal runtime utilities (required by supervisord and health checks)
    pkgs.coreutils
    pkgs.bash

    # User definition and supervisord config
    toon-user
    supervisord-conf

    # Application code and production dependencies
    app-dir
  ];

  config = {
    # CMD matches Dockerfile.oyster: run supervisord for multi-process management
    Cmd = [ "${pkgs.python3Packages.supervisor}/bin/supervisord" "-c" "/etc/supervisord.conf" ];

    # Exposed ports match Dockerfile.oyster:
    #   3100 - BLS HTTP API (enriched /health, /handle-packet)
    #   7100 - Nostr Relay WebSocket
    #   1300 - Attestation HTTP server (/attestation/raw, /health)
    ExposedPorts = {
      "3100/tcp" = { };
      "7100/tcp" = { };
      "1300/tcp" = { };
    };

    # Environment variables
    Env = [
      "NODE_ENV=production"
      "BLS_PORT=3100"
      "WS_PORT=7100"
      "PATH=/bin:${pkgs.nodejs_20}/bin:${pkgs.coreutils}/bin:${pkgs.bash}/bin:${pkgs.python3Packages.supervisor}/bin"
    ];

    WorkingDir = "/app";

    # Non-root user for container execution
    User = "toon";

    # Data volume for persistent storage
    Volumes = {
      "/data" = { };
    };
  };
}
