#!/usr/bin/env python3
"""
Build del frontend Turni: src/App.jsx  ->  index.html autosufficiente.

L'app deve funzionare OFFLINE e SENZA CDN (i CDN risultano bloccati sul
dispositivo dell'utente): React e ReactDOM vengono incorporati inline da
vendor/, e il JSX viene transpilato in JS puro con esbuild. Il risultato è
un index.html identico per struttura a quello storico: error handler a
schermo, React inline, codice app transpilato, registrazione service worker.

Uso:
    python3 build.py              # genera index.html
    python3 build.py --bump      # incrementa la versione del SW e genera
    python3 build.py --check     # genera in un file temporaneo e confronta
                                 # con l'index.html esistente (non scrive)

Requisiti: python3 e il binario esbuild (cercato in ../tools/esbuild, in
tools/esbuild o nel PATH; se assente viene scaricato in ../tools/).
"""
import re
import subprocess
import sys
import tempfile
import urllib.request
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "src" / "App.jsx"
TEMPLATE = HERE / "template.html"
VENDOR_REACT = HERE / "vendor" / "react.production.min.js"
VENDOR_REACT_DOM = HERE / "vendor" / "react-dom.production.min.js"
OUT = HERE / "index.html"
SW = HERE / "sw.js"

ESBUILD_VERSION = "0.21.5"


def trova_esbuild():
    """Cerca esbuild nelle posizioni note; se manca lo scarica in ../tools/."""
    candidati = [
        HERE.parent / "tools" / "esbuild",
        HERE / "tools" / "esbuild",
    ]
    for c in candidati:
        if c.is_file():
            return str(c)
    from shutil import which
    nel_path = which("esbuild")
    if nel_path:
        return nel_path
    # scarica il binario standalone (una tantum)
    dest_dir = HERE.parent / "tools"
    dest_dir.mkdir(exist_ok=True)
    url = (f"https://registry.npmjs.org/@esbuild/darwin-arm64/-/"
           f"darwin-arm64-{ESBUILD_VERSION}.tgz")
    print(f"esbuild non trovato: lo scarico da {url}")
    with tempfile.NamedTemporaryFile(suffix=".tgz") as tmp:
        urllib.request.urlretrieve(url, tmp.name)
        with tarfile.open(tmp.name) as tar:
            membro = tar.getmember("package/bin/esbuild")
            membro.name = "esbuild"
            tar.extract(membro, dest_dir)
    binario = dest_dir / "esbuild"
    binario.chmod(0o755)
    return str(binario)


def transpila(jsx: str, esbuild: str) -> str:
    """JSX -> JS puro (React.createElement), via esbuild in modalità transform."""
    proc = subprocess.run(
        [esbuild, "--loader=jsx", "--jsx=transform", "--target=es2017"],
        input=jsx.encode("utf-8"), capture_output=True,
    )
    if proc.returncode != 0:
        sys.exit("ERRORE esbuild:\n" + proc.stderr.decode("utf-8"))
    return proc.stdout.decode("utf-8")


def prepara_sorgente(jsx: str):
    """Adatta il modulo ES all'esecuzione inline: niente import/export.

    - `import React, { A, B } from "react";`  ->  rimosso; gli hook vengono
      esposti con `const { A, B } = React;` in testa al bundle.
    - `export default function App` -> `function App` (il render è nel wrapper).
    Ritorna (sorgente_pulito, riga_hooks).
    """
    m = re.search(r'^import React,\s*\{([^}]*)\}\s*from\s*"react";?\s*$',
                  jsx, re.MULTILINE)
    if not m:
        sys.exit('ERRORE: atteso `import React, { ... } from "react";` in App.jsx')
    hooks = m.group(1).strip()
    jsx = jsx[:m.start()] + jsx[m.end():]

    jsx, n = re.subn(r'^export default function App\b',
                     "function App", jsx, count=1, flags=re.MULTILINE)
    if n != 1:
        sys.exit("ERRORE: atteso `export default function App` in App.jsx")
    return jsx, f"const {{ {hooks} }} = React;"


def bump_sw() -> str:
    """Incrementa turni-vN in sw.js e ritorna la nuova versione."""
    sw = SW.read_text(encoding="utf-8")
    m = re.search(r"turni-v(\d+)", sw)
    if not m:
        sys.exit("ERRORE: versione cache turni-vN non trovata in sw.js")
    vecchia, nuova = int(m.group(1)), int(m.group(1)) + 1
    SW.write_text(sw.replace(f"turni-v{vecchia}", f"turni-v{nuova}"),
                  encoding="utf-8")
    return f"turni-v{nuova}"


def build() -> str:
    esbuild = trova_esbuild()
    jsx, riga_hooks = prepara_sorgente(SRC.read_text(encoding="utf-8"))
    app_js = transpila(jsx, esbuild)

    # wrapper identico alla struttura storica di index.html:
    # hooks + try { codice app + render } catch -> errore a schermo
    blocco_app = (
        riga_hooks + "\n"
        "try {\n"
        + app_js +
        'const root = ReactDOM.createRoot(document.getElementById("root"));\n'
        "root.render(React.createElement(App));\n"
        "} catch (e) {\n"
        "  var box = document.getElementById('errbox');\n"
        "  if (box) { box.style.display='block'; box.textContent="
        "'Errore React:\\n'+(e&&e.message?e.message:e); }\n"
        "}"
    )

    html = TEMPLATE.read_text(encoding="utf-8")
    for segnaposto, contenuto in [
        ("{{REACT}}", VENDOR_REACT.read_text(encoding="utf-8").strip("\n")),
        ("{{REACT_DOM}}", VENDOR_REACT_DOM.read_text(encoding="utf-8").strip("\n")),
        ("{{APP_JS}}", blocco_app),
    ]:
        if segnaposto not in html:
            sys.exit(f"ERRORE: segnaposto {segnaposto} assente dal template")
        html = html.replace(segnaposto, contenuto)
    return html


def main():
    args = set(sys.argv[1:])
    if "--check" in args:
        nuovo = build()
        vecchio = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        dest = Path(tempfile.gettempdir()) / "index.check.html"
        dest.write_text(nuovo, encoding="utf-8")
        print(f"Build di controllo scritta in {dest}")
        print(f"index.html attuale : {len(vecchio):>7} byte")
        print(f"build di controllo : {len(nuovo):>7} byte")
        print("identici" if nuovo == vecchio else
              "diversi (atteso se il transpiler è cambiato: confrontare in app)")
        return

    if "--bump" in args:
        print("Service worker:", bump_sw())

    OUT.write_text(build(), encoding="utf-8")
    print(f"OK: generato {OUT} ({OUT.stat().st_size} byte)")


if __name__ == "__main__":
    main()
