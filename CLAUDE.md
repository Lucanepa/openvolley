# Project Guidelines

## Package Management

After installing, updating, or upgrading any npm package, always run `npm install` in the relevant frontend directory to ensure `package-lock.json` stays in sync.

```bash
cd escoresheet/frontend && npm install
```

## Screen orientation (owner, 09.11.2026)

- **Scorer (the main app, the scoring screen): landscape** on tablets and computers. A tablet held upright is asked to rotate; only a phone gets the phone layout upright.
- **Referee and bench tablets: portrait.** Design and check their dashboards upright (tablet and phone); the referee view locks to portrait where the platform allows it.
- Check phone layouts on a small phone too (360x640 / 360x740 CSS px), not only on a large one.
