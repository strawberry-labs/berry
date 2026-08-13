import { Template } from "e2b";
import { fileURLToPath } from "node:url";

const fileContextPath = fileURLToPath(new URL("./.build-context/", import.meta.url));

const aptPackages = [
  "ca-certificates",
  "curl",
  "file",
  "fontconfig",
  "fonts-dejavu-core",
  "fonts-noto",
  "fonts-noto-cjk",
  "fonts-noto-color-emoji",
  "fonts-ubuntu",
  "ghostscript",
  "git",
  "libcairo2-dev",
  "libffi-dev",
  "libgdk-pixbuf-2.0-dev",
  "libjpeg-dev",
  "libpango1.0-dev",
  "libpng-dev",
  "libxml2-dev",
  "libxslt1-dev",
  "libz-dev",
  "libreoffice-calc",
  "libreoffice-impress",
  "libreoffice-writer",
  "locales",
  "pandoc",
  "poppler-utils",
  "python3",
  "python3-dev",
  "python3-pip",
  "python3-venv",
  "qpdf",
  "ripgrep",
  "tesseract-ocr",
  "unzip",
  "zip",
];

export const template = Template({
  fileContextPath,
})
  .fromUbuntuImage("24.04")
  .aptInstall(aptPackages)
  .runCmd("locale-gen en_US.UTF-8", { user: "root" })
  .runCmd(
    "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*",
    { user: "root" },
  )
  .copy("requirements.lock", "/opt/aesg/requirements.lock")
  .runCmd(
    "python3 -m venv /opt/aesg/venv && /opt/aesg/venv/bin/pip install --no-cache-dir --upgrade pip==25.1.1 && /opt/aesg/venv/bin/pip install --no-cache-dir -r /opt/aesg/requirements.lock && printf '%s\\n' '#!/bin/sh' 'exec /opt/aesg/venv/bin/python \"$@\"' > /usr/local/bin/python && cp /usr/local/bin/python /usr/local/bin/python3 && printf '%s\\n' '#!/bin/sh' 'exec /opt/aesg/venv/bin/pip \"$@\"' > /usr/local/bin/pip && chmod 0755 /usr/local/bin/python /usr/local/bin/python3 /usr/local/bin/pip",
    { user: "root" },
  )
  .copy("fonts", "/usr/local/share/fonts/aesg")
  .runCmd(
    "fc-cache -f && test \"$(fc-match -f '%{family}' Verdana)\" = Verdana",
    { user: "root" },
  )
  .runCmd(
    "id -u user >/dev/null 2>&1 || useradd --create-home --shell /bin/bash user; mkdir -p /workspace/input /workspace/inputs /workspace/outputs /workspace/tmp /workspace/rendered /workspace/runtime-skills; ln -sfn /workspace/outputs /workspace/output; chmod -R a+rX /opt/aesg; chown -R user:user /workspace",
    { user: "root" },
  )
  .setEnvs({
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    SAL_USE_VCLPLUGIN: "gen",
    VIRTUAL_ENV: "/opt/aesg/venv",
    PATH: "/opt/aesg/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  })
  .setWorkdir("/workspace")
  .setUser("user");
