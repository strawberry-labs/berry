import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
 testDir:"./tests",testMatch:"queue-steering.spec.ts",workers:1,reporter:"list",timeout:45000,
 use:{baseURL:"http://127.0.0.1:3110",trace:"retain-on-failure",screenshot:"only-on-failure"},
 webServer:{command:"BERRY_WEB_API_BASE_URL=http://127.0.0.1:3198 BERRY_WEB_DEMO_MODE=false corepack pnpm exec vite dev --host 127.0.0.1 --port 3110 --strictPort",url:"http://127.0.0.1:3110",reuseExistingServer:false,timeout:120000},
 expect:{timeout:15000},projects:[{name:"chromium",use:{...devices["Desktop Chrome"]}}],
});
