# -*- mode: python ; coding: utf-8 -*-
"""Spec PyInstaller (mode onedir) : fige l'app Python en un dossier
pole-scoring/ contenant pole-scoring.exe + ses dependances, sur le meme
principe que dist/portable cote version Node (cf. app_pole/scripts/
build-portable.ps1). C'est ce dossier que l'installateur Inno Setup
(installer/pole-scoring.iss) empaquette ensuite."""

from PyInstaller.utils.hooks import collect_all

datas = [("src/pole_scoring/webui", "webui")]
binaries = []
hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
]

# pywebview pilote la fenetre native via pythonnet/clr_loader (WebView2) sur
# Windows : ces deux paquets embarquent des assemblies .NET que PyInstaller
# ne detecte pas tout seul, d'ou collect_all plutot qu'un simple hiddenimport.
for package_name in ("pythonnet", "clr_loader", "webview"):
    package_datas, package_binaries, package_hidden_imports = collect_all(package_name)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden_imports

a = Analysis(
    ["entry_point.py"],
    pathex=["src"],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="pole-scoring",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    icon="resources/pole-scoring.ico",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="pole-scoring",
)
