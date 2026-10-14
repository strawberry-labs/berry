import { expect, test } from "@playwright/test";
const api="http://127.0.0.1:3198";
test.beforeEach(async({context,request,page})=>{
 await request.post(`${api}/__e2e/reset`);
 await context.addCookies([{name:"queue-test",value:"fixture",domain:"127.0.0.1",path:"/"}]);
 const {taskId}=await (await request.get(`${api}/__e2e/state`)).json();
 await page.goto(`/tasks/${taskId}`);
 await expect(page.getByTestId("web-app-shell")).toHaveAttribute("data-hydrated","true");
 await expect(page.getByRole("heading",{name:"Queue browser verification"})).toBeVisible();
});
test("Enter queues durably and reconnects to the next answer after completion",async({page,request})=>{
 const editor=page.locator('[contenteditable="true"]').first();await editor.fill("Browser queued correction");await editor.press("Enter");
 await expect.poll(async()=> (await (await request.get(`${api}/__e2e/state`)).json()).queue.items.length).toBe(1);
 await page.reload();await expect(page.getByText("Browser queued correction",{exact:true})).toBeVisible();
 await request.post(`${api}/__e2e/complete`);
 await expect(page.getByText("Answer: Browser queued correction",{exact:true})).toBeVisible();
});
test("lost enqueue response retains text and retries the same idempotency key",async({page,request})=>{
 await request.post(`${api}/__e2e/fail-queue`);
 const editor=page.locator('[contenteditable="true"]').first();await editor.fill("Keep this correction");await editor.press("Enter");
 await expect(page.getByText("Unable to queue this prompt. Your text is still here; retry to send it.",{exact:false})).toBeVisible();
 await expect(editor).toHaveText("Keep this correction");await editor.press("Enter");
 await expect.poll(async()=> (await (await request.get(`${api}/__e2e/state`)).json()).calls.filter((v:string)=>v.startsWith("enqueue:")).length).toBe(2);
 const state=await (await request.get(`${api}/__e2e/state`)).json();expect(new Set(state.calls.filter((v:string)=>v.startsWith("enqueue:"))).size).toBe(1);expect(state.queue.items).toHaveLength(1);
});
test("Control+Enter cancels before persisting and admitting the steering prompt",async({page,request})=>{
 const editor=page.locator('[contenteditable="true"]').first();await editor.fill("Change the current instruction");await editor.press("Control+Enter");
 await expect.poll(async()=> (await (await request.get(`${api}/__e2e/state`)).json()).calls.includes("admit")).toBe(true);
 const state=await (await request.get(`${api}/__e2e/state`)).json();expect(state.calls.filter((v:string)=>["cancel","append","admit"].includes(v))).toEqual(["cancel","append","admit"]);
 expect(state.runs[0].state).toBe("cancelled");
 await request.post(`${api}/__e2e/complete`);await expect(page.getByText("Answer: Change the current instruction",{exact:true})).toBeVisible();
});

test("queued-item Steer interrupts the active answer and runs the selected prompt",async({page,request})=>{
 const editor=page.locator('[contenteditable="true"]').first();await editor.fill("Prioritize this queued prompt");await editor.press("Enter");
 await expect(page.getByRole("button",{name:"Steer",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Steer",exact:true}).click();
 await expect.poll(async()=> (await (await request.get(`${api}/__e2e/state`)).json()).runs.length).toBe(2);
 const state=await (await request.get(`${api}/__e2e/state`)).json();expect(state.runs[0].state).toBe("cancelled");expect(state.runs[1].input).toBe("Prioritize this queued prompt");
 await request.post(`${api}/__e2e/complete`);await expect(page.getByText("Answer: Prioritize this queued prompt",{exact:true})).toBeVisible();
});
