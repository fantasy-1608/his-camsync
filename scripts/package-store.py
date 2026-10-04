"""Build and verify a minimal Chrome Web Store runtime package."""
from pathlib import Path
import hashlib, json, zipfile
root = Path(__file__).resolve().parents[1]
source = root / 'extension'
manifest = json.loads((source / 'manifest.json').read_text())
assert manifest['manifest_version'] == 3
assert len(manifest['description']) <= 132
files = {'manifest.json', manifest['background']['service_worker']}
files.update(manifest['icons'].values())
for entry in manifest['content_scripts']:
    files.update(entry.get('js', [])); files.update(entry.get('css', []))
for name in files:
    assert (source / name).is_file(), name
output = root / f"camsync-chrome-store-v{manifest['version']}.zip"
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(files):
        archive.write(source / name, name)
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert set(archive.namelist()) == files
    for name in files:
        assert archive.read(name) == (source / name).read_bytes()
digest = hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix('.sha256').write_text(f'{digest}  {output.name}\n')
print(f'{output.name}: {len(files)} runtime files, {output.stat().st_size} bytes, SHA256 {digest}')
