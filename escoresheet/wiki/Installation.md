# Installation & Development Guide

This guide covers how to set up your development environment for Openvolley eScoresheet.

## Prerequisites

- **Node.js**: Ensure you have Node.js installed (LTS version recommended).
- **Git**: For version control.
- **PowerShell (Windows)**: Recommended for running scripts on Windows.

## Setup

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/lucacanepa/openvolley.git
    cd openvolley/escoresheet/frontend
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

## Development

### Web Development
To start the development server for the web version:

```bash
npm run dev
```
This will start Vite and the app will be accessible at `http://localhost:5173`.

### Electron Development
To start the application in Electron mode (Desktop):

```bash
npm run electron:dev
```
This command uses `concurrently` to:
1.  Start the Vite dev server.
2.  Wait for the dev server to be ready.
3.  Launch the Electron main process.

> **Note:** The `electron/main.js` is the entry point for the main process.

### HTTPS Development
If you need to test features requiring HTTPS (like installing PWA locally or certain improved security features):

```bash
npm run dev:https
# OR
npm run start:https
```

## Project Scripts

Here are some commonly used scripts from `package.json`:

| Script | Description |
| :--- | :--- |
| `dev` | Starts the web dev server (Vite). |
| `electron:dev` | Starts the Electron dev environment. |
| `build` | Builds the web assets for production. |
| `preview` | Previews the built web assets locally. |
| `lint` | Runs the linter (if configured). |

## Environment Variables

Copy `.env.example` to `.env` and configure your local environment variables if necessary (e.g., Supabase credentials).

```bash
cp .env.example .env
```
