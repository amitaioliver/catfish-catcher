#!/usr/bin/env python3
"""Builds the Chrome and Firefox packages from the same source files.

    python3 build.py      ->  dist/catfish-catcher-chrome.zip
                              dist/catfish-catcher-firefox.zip
"""
import os, shutil, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = ['content.js', 'icon16.png', 'icon32.png', 'icon48.png', 'icon128.png', 'README.md', 'LICENSE']
TARGETS = {'chrome': 'manifest.json', 'firefox': 'manifest.firefox.json'}

dist = os.path.join(HERE, 'dist')
shutil.rmtree(dist, ignore_errors=True)
for name, manifest in TARGETS.items():
    folder = os.path.join(dist, f'catfish-catcher-{name}')
    os.makedirs(folder)
    for f in SHARED:
        shutil.copy(os.path.join(HERE, f), folder)
    shutil.copy(os.path.join(HERE, manifest), os.path.join(folder, 'manifest.json'))
    # files at the root of the zip, as Firefox (and the add-ons site) expect
    with zipfile.ZipFile(folder + '.zip', 'w', zipfile.ZIP_DEFLATED) as z:
        for f in sorted(os.listdir(folder)):
            z.write(os.path.join(folder, f), f)
    print('built', folder + '.zip')
