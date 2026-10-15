<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/b2faf561-da83-4a51-b7a2-3cd1c9504e83

## Run Locally

**Prerequisites:** Node.js and Java 25 or later. The included Maven launcher downloads Maven the first time it is run.

1. Install the frontend and backend dependencies:
   `npm install --legacy-peer-deps`
2. Start the Spring Boot host (it starts the existing Node/Vite app backend automatically):
   `.\mvnw.cmd spring-boot:run`
3. Open [http://localhost:8080](http://localhost:8080).

The demo data and emergency guidance are configured for Chennai, Tamil Nadu. The Indian emergency ambulance number shown in the interface is 108. A `GEMINI_API_KEY` in `.env` enables Gemini responses; without it, the built-in rule-based assistant remains available.
