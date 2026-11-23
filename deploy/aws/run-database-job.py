"""Run one release database job with the current RDS-managed owner credential."""
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import quote, unquote, urlsplit, urlunsplit


def owner_connection(configured, endpoint, database, managed):
    url = urlsplit(configured)
    if (url.scheme not in ("postgres", "postgresql") or url.hostname != endpoint
            or unquote(url.path[1:]) != database or not url.username
            or unquote(url.username) != managed.get("username") or not managed.get("password")):
        raise ValueError("Configured database or owner does not match the production stack")
    authority = quote(managed["username"], safe="") + ":" + quote(managed["password"], safe="") + "@" + endpoint
    if url.port:
        authority += ":" + str(url.port)
    return urlunsplit((url.scheme, authority, url.path, url.query, url.fragment))


def main():
    env_file, job = sys.argv[1:]
    if job not in ("db-migrate", "postgres-roles"):
        raise ValueError("Unsupported release database job")
    lines = Path(env_file).read_text().splitlines()
    configured = next(line.partition("=")[2].strip().strip('"').strip("'")
                      for line in reversed(lines) if line.startswith("BERRY_DATABASE_URL="))
    managed = json.loads(subprocess.check_output([
        "aws", "secretsmanager", "get-secret-value", "--region", os.environ["BERRY_AWS_REGION"],
        "--secret-id", os.environ["BERRY_DEPLOY_RDS_SECRET"], "--version-stage", "AWSCURRENT",
        "--query", "SecretString", "--output", "text",
    ]))
    # Docker Compose receives the credential through its process environment only.
    os.environ["BERRY_DATABASE_URL"] = owner_connection(
        configured, os.environ["BERRY_DEPLOY_RDS_ENDPOINT"], os.environ["BERRY_DEPLOY_RDS_DATABASE"], managed)
    os.execvp("docker", ["docker", "compose", "--env-file", env_file, "-f", "deploy/compose.yaml",
                         "-f", "deploy/compose.aws.yaml", "run", "--rm", "--no-deps", job])


if __name__ == "__main__":
    main()
