#!/usr/bin/env python3
"""Builds ../index.html (one self-contained file) from the three sources in this folder."""
import os
here = os.path.dirname(os.path.abspath(__file__))
rd = lambda n: open(os.path.join(here, n), encoding='utf-8').read()
html, app, fp = rd('index.html'), rd('app.js'), rd('flatpickr.min.js')
tag = '<script src="flatpickr.min.js"></script>\n<script src="app.js"></script>'
assert html.count(tag) == 1, 'script tags not found in src/index.html'
assert '</script' not in app.lower() and '</script' not in fp.lower()
out = html.replace(tag, '<script>\n' + fp + '\n</script>\n<script>\n' + app + '\n</script>')
open(os.path.join(here, '..', 'index.html'), 'w', encoding='utf-8').write(out)
print('built index.html,', len(out), 'bytes')
