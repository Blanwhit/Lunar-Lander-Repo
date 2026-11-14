# Moon LOD pipeline + viewer.  (Windows without make: run the python lines directly.)
PY ?= .venv/Scripts/python
ifeq ($(OS),Windows_NT)
else
PY ?= .venv/bin/python
endif
MAX_LEVEL ?= 11
WORKERS ?= 24

.PHONY: all venv download inspect basisu tiles overviews heights colour stars meta stats ephem earth web build serve clean-tiles

all: tiles build

venv:
	python -m venv .venv && $(PY) -m pip install -r pipeline/requirements.txt

download:
	$(PY) -I pipeline/download.py --workers 16

inspect:
	$(PY) -I pipeline/inspect_data.py

# builds tools/basisu(.exe) from Binomial's sources (see pipeline/build_basisu.sh)
basisu:
	sh pipeline/build_basisu.sh

overviews:
	$(PY) -I pipeline/build.py overviews
heights: overviews
	$(PY) -I pipeline/build.py heights --max-level $(MAX_LEVEL) --workers $(WORKERS)
colour:
	$(PY) -I pipeline/build.py colour
stars:
	$(PY) -I pipeline/build.py stars
meta:
	$(PY) -I pipeline/build.py meta
stats:
	$(PY) -I pipeline/build.py stats

# full tile pyramid: heights (cube-sphere quadtree) + KTX2 colour + star cubemaps
tiles: heights colour stars meta stats ephem earth

# Sun/Earth state vectors seen from the Moon, 2000-2050, from the JPL Horizons API
ephem:
	$(PY) -I pipeline/ephemeris.py --start 2000 --end 2050 --validate

# Earth texture for the sky (NASA Blue Marble, SVS 2915) -> web/public/sky/earth.jpg
earth:
	$(PY) -I pipeline/download.py --groups earth
	$(PY) -I pipeline/build.py earth

web:
	cd web && npm install
build:
	cd web && npm run build
serve:
	cd web && npm run preview

clean-tiles:
	rm -rf web/public/tiles
