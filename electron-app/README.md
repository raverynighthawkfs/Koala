# Koala Electron Wrapper

This folder contains a minimal Electron scaffold that loads the existing sampler UI found at `default/sampler/Index.html`.

Quick start

1. Change into this folder:

```bash
cd electron-app
```

2. Install dev dependencies (this will download Electron):

```bash
npm install
```

3. Start the app:

```bash
npm start
```

Notes

- The renderer HTML fetches `sampler.json` and wav files via relative URLs. If you encounter errors fetching local files when running inside Electron, you can run a simple static server from the `default/sampler` directory and open `Index.html` in a browser instead:

```bash
cd default/sampler
python3 -m http.server 8000
open http://localhost:8000/Index.html
```

- This scaffold is intentionally minimal. I can instead wire a tiny static server into the Electron process or adapt the renderer to use a preload-provided filesystem API if you want an all-in-one packaged experience.
