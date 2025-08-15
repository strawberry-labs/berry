"use client"

import { LoaderIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { ThemeSwitcher, ThemeType } from "./ui/shadcn-io/theme-switcher";
import { useTheme } from "next-themes";

export function UpdateInformation() {
  const [name, setName] = useState("");

  const { data:session, update } = useSession();

  const router = useRouter();

  const [disable, setDisable] = useState(false)

  const {resolvedTheme, setTheme} = useTheme()

  const handleSubmit = async () =>{
    if(session){
      setDisable(true)
      await fetch("/api/auth/update-name", {
        method: "POST",
        body: JSON.stringify({ name }),
        headers: { "Content-Type": "application/json" },
      });
      await update({ name });
      router.refresh()
    }
  }

  return (
    <>
    <ThemeSwitcher defaultValue="dark" onChange={setTheme} value={resolvedTheme as ThemeType} className="absolute top-4 right-4"/>
    <div className="bg-muted">
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10 max-w-sm md:max-w-[24 rem] mx-auto">
      <div className="w-full max-w-sm">
        <div className="flex flex-col gap-6">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await handleSubmit()
            }}
            >
            <div className="flex flex-col gap-6">
                <h1 className="text-[1.32rem] font-bold text-center">You’re all set to start, but first, what should we call you?</h1>
              <div className="flex flex-col gap-6">
                <div className="grid gap-3">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="John Doe"
                    disabled={disable}
                    required
                    />
                </div>
                <Button type="submit" className="relative w-full flex items-center justify-center" disabled={disable}>
                    <span className="absolute left-[34.5%]">
                      {disable && <LoaderIcon className="animate-spin" />}
                    </span>
                  <span>Continue</span>
                </Button>
              </div>
            </div>
          </form>
        </div>
        </div>
      </div>
    </div>
  </>
  );
}
