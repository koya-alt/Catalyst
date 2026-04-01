# Discord Bot Website Template + Control Panel

## Overview

A Discord bot landing page with a password-protected remote control dashboard. Built with Node.js/Express on the backend and Discord.js for bot operations.

## Project Structure

- `server.js` — Express backend server (port 5000), handles auth, sessions, and all Discord bot API calls
- `index.html` — Public landing page
- `login.html` — Password-protected login page for the control panel
- `dashboard.html` — Bot control panel (requires login)
- `assets/` — Static assets (CSS, JS, images, fonts)

## Running the Project

```
node server.js
```

Runs on port 5000. Configured as the "Start application" workflow.

## Environment Variables / Secrets

- `ADMIN_PASSWORD` — Password to log into the control panel (set as a Replit Secret)
- `SESSION_SECRET` — Session signing secret (auto-generated, set as env var)

## Features

- Password login page to protect the dashboard
- Connect your Discord bot via token
- View all servers the bot is in
- Per-server actions: leave server, delete all channels, delete all roles, kick all members, ban all members, send messages to any channel
- Action log showing real-time results of each operation

## Deployment

Configured as an **autoscale** deployment running `node server.js`.

## Technologies

- Node.js + Express
- Discord.js v14
- express-session (session auth)
- Bootstrap 5, HTML5, CSS3
