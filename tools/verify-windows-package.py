import hashlib, json, struct, sys, zipfile
from datetime import datetime, timezone
from pathlib import Path

version = json.loads(Path('package.json').read_text())['version']
package = Path(sys.argv[1] if len(sys.argv) > 1 else f'release/v{version}/windows/Watson-{version}-win.zip')
digest = lambda value: hashlib.sha256(value).hexdigest()
with zipfile.ZipFile(package) as archive:
    names = archive.namelist()
    assert 'Watson.exe' in names and 'resources/app.asar' in names
    assert not any(name.endswith('watson-capture') for name in names), 'Mac helper present in Windows archive'
    executable = archive.read('Watson.exe')
    pe_offset = struct.unpack_from('<I', executable, 0x3c)[0]
    assert executable[pe_offset:pe_offset+4] == b'PE\0\0'
    assert struct.unpack_from('<H', executable, pe_offset+4)[0] == 0x8664, 'Expected x64 PE executable'
    asar = archive.read('resources/app.asar')
    extra_resources = []
    for local, packed_path in [('config/update-config.json', 'resources/update-config.json'), ('native/windows/ConferenceActivity.cs', 'resources/windows/ConferenceActivity.cs'), ('native/windows/ConferenceActivity.ps1', 'resources/windows/ConferenceActivity.ps1')]:
        packed = archive.read(packed_path)
        assert digest(packed) == digest(Path(local).read_bytes()), 'Stale extra resource: ' + packed_path
        extra_resources.append({'path': packed_path, 'sha256': digest(packed), 'bytes': len(packed)})
base = 8 + struct.unpack_from('<I', asar, 4)[0]
header_length = struct.unpack_from('<I', asar, 12)[0]
header = json.loads(asar[16:16+header_length])
def member(filename):
    node = header
    for part in filename.split('/'):
        node = node['files'][part]
    assert not node.get('unpacked'), filename
    offset = base + int(node['offset'])
    return asar[offset:offset+node['size']]
files = [path for directory in ('dist', 'dist-electron') for path in Path(directory).rglob('*') if path.is_file()]
matched = []
for path in files:
    packed = member(path.as_posix())
    assert digest(packed) == digest(path.read_bytes()), 'Stale build: ' + str(path)
    matched.append({'path': path.as_posix(), 'sha256': digest(packed), 'bytes': len(packed)})
metadata = json.loads(member('package.json'))
assert metadata['version'] == version
result = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'package': str(package.resolve()), 'version': metadata['version'], 'architecture': 'x64', 'validPE': True, 'matchedBuildFiles': matched, 'extraResources': extra_resources, 'asarSha256': digest(asar), 'archiveSha256': digest(package.read_bytes()), 'archiveBytes': package.stat().st_size, 'macHelperPresent': False, 'releaseSigned': False, 'windowsRuntimeVerified': False, 'statement': 'Archive structure, x64 executable and exact current built-file and extra-resource hashes verified on macOS. This does not prove Windows launch or OS capture.'}
Path('evidence/windows-package-validation.json').write_text(json.dumps(result, indent=2))
print(json.dumps({'version': metadata['version'], 'matchedFiles': len(matched), 'validPE': True, 'windowsRuntimeVerified': False}))
