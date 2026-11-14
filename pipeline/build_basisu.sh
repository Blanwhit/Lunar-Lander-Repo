#!/bin/sh
# Build the Basis Universal encoder (basisu) from source with g++ (no cmake needed).
set -e
TAG=v1_50_0_2
cd "$(dirname "$0")/../tools"
if [ ! -d basis ]; then
  python - <<PY
import json, urllib.request, os
tag='$TAG'
t=json.load(urllib.request.urlopen(f'https://api.github.com/repos/BinomialLLC/basis_universal/git/trees/{tag}?recursive=1'))
for e in t['tree']:
    p=e['path']
    if e['type']!='blob': continue
    if not (p.startswith(('encoder/','transcoder/','zstd/')) or p in ('basisu_tool.cpp','LICENSE')): continue
    if p.endswith(('.png','.ktx','.basis','.ktx2','.exr','.dds','.astc')): continue
    os.makedirs(os.path.dirname(os.path.join('basis',p)) or '.', exist_ok=True)
    open(os.path.join('basis',p),'wb').write(urllib.request.urlopen(f'https://raw.githubusercontent.com/BinomialLLC/basis_universal/{tag}/{p}').read())
PY
fi
cd basis && mkdir -p obj
F="-O3 -DNDEBUG -fno-strict-aliasing -DBASISU_SUPPORT_SSE=1 -msse4.1 -DBASISU_SUPPORT_OPENCL=0 -DBASISD_SUPPORT_KTX2_ZSTD=1 -w"
gcc -O3 -c zstd/zstd.c -o obj/zstd.o -w
for f in encoder/*.cpp encoder/3rdparty/*.cpp transcoder/basisu_transcoder.cpp basisu_tool.cpp; do
  g++ -std=c++17 $F -c "$f" -o "obj/$(basename "${f%.cpp}").o" &
done
wait
g++ -o ../basisu obj/*.o -static -static-libgcc -static-libstdc++ -lpthread
../basisu -version | head -1
