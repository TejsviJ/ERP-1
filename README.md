# VXL BD Client Desk

A portfolio project demonstrating a browser-based ERP/client desk interface and a Supabase-backed data layer. I built it to explore how an ERP-style workflow can manage company and client records.

> **Portfolio demo:** This project has a deployed demo to showcase my work. It is not intended for production use. Do not enter real customer or business data.

## Project overview

- `index.html` — application interface.
- `vxl-data.js` — Supabase client and data access layer.
- `config.example.js` — placeholder template for local Supabase configuration.
- `config.js` — local configuration file; ignored by Git and not included in this repository.

## Run locally

1. Copy `config.example.js` to `config.js`.
2. Add your Supabase project URL and publishable/legacy anon key to `config.js`.
3. Start a local web server from this directory:

   ```sh
   python3 -m http.server 8000
   ```

4. Open `http://localhost:8000` in your browser.

The local `config.js` is not committed. Never put a Supabase secret or `service_role` key in browser code or this repository. The browser app is designed to use a publishable/anon key; database access still depends on correctly configured Row Level Security and grants.

## Notes

This repository contains the source code for the deployed portfolio demo. Any screenshots or sample data shared with it should be synthetic and free of customer, account, or company information.

## License

No license is currently specified. Add one if you want others to reuse or distribute this project.
