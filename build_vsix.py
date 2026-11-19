"""Package CrewMon as a .vsix without vsce (the system Node is too old for it).

A .vsix is a zip with [Content_Types].xml, extension.vsixmanifest and the extension under extension/.
Usage: python3 build_vsix.py  ->  dist/crewmon-<version>.vsix
"""
import json
import os
import zipfile
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.abspath(__file__))
FILES = ["package.json", "extension.js", "snapshot.js", "media/map.html", "media/critters.js", "media/icon.png", "media/icon.svg", "keeper/keeper", "messenger/.claude-plugin/plugin.json", "messenger/hooks/hooks.json", "messenger/hooks/register.ts", "README.md", "LICENSE", "docs/critters.png", "docs/styles.png"]

pkg = json.load(open(os.path.join(ROOT, "package.json")))
ver, name, pub = pkg["version"], pkg["name"], pkg["publisher"]

content_types = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension=".json" ContentType="application/json"/>
<Default Extension=".js" ContentType="application/javascript"/>
<Default Extension=".html" ContentType="text/html"/>
<Default Extension=".md" ContentType="text/markdown"/>
<Default Extension=".png" ContentType="image/png"/>
<Default Extension=".svg" ContentType="image/svg+xml"/>
<Default Extension=".ts" ContentType="text/plain"/>
<Default Extension="" ContentType="text/plain"/>
<Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>"""

manifest = f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{name}" Version="{ver}" Publisher="{pub}"/>
    <DisplayName>{escape(pkg["displayName"])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg["description"])}</Description>
    <Categories>Other</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{pkg["engines"]["vscode"]}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true"/>
  </Assets>
</PackageManifest>"""

os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
out = os.path.join(ROOT, "dist", f"{name}-{ver}.vsix")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("extension.vsixmanifest", manifest)
    for f in FILES:
        z.write(os.path.join(ROOT, f), "extension/" + f)
print(out)
