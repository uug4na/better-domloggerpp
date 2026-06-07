install:
	npm install --global web-ext
	cd scripts && npm install

# Bundle the repo's ./configs into the extension so the options "Config library" can load them.
# GLOBAL.json is excluded (it is auto-merged and not user-selectable).
copy-configs:
	mkdir -p src/configs
	rm -f src/configs/*.json
	cp ../configs/*.json src/configs/
	rm -f src/configs/GLOBAL.json
	cd src/configs && ls *.json | sed 's/.*/"&"/' | paste -sd, - | sed 's/^/[/; s/$$/]/' > index.json

build: copy-configs
	cd scripts && npm run build
	ln -sf manifest-firefox.json manifest.json && web-ext build --overwrite-dest --filename {name}pp_firefox-{version}.zip
	ln -sf manifest-chrome.json manifest.json && web-ext build --overwrite-dest --filename {name}pp_chromium-{version}.zip

dev-firefox: copy-configs
	cd scripts && npm run build
	ln -sf manifest-firefox.json manifest.json && web-ext run -t firefox-desktop --devtools

dev-chromium: copy-configs
	cd scripts && npm run build
	ln -sf manifest-chrome.json manifest.json && web-ext run -t chromium --devtools
