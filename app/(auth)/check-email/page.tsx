"use client"

import { Button } from "@/components/ui/button";
import { ArrowLeft, MailIcon } from "lucide-react";
import Link from "next/link";

export default function CheckEmail() {
  return (
    <div className="bg-muted flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
      <div className="w-full max-w-sm md:max-w-[24 rem]">
        <div className="flex flex-col gap-6 p-6 md:p-8">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col items-center gap-2">
              <div className="flex flex-col items-center gap-2 font-medium">
                <div className="flex size-8 items-center justify-center rounded-md">
                  <MailIcon className="size-14" />
                </div>
                <span className="sr-only">Check email</span>
              </div>
              <h1 className="text-xl font-bold">Check your email</h1>
              <div className="text-center text-sm">
                Open your email app to verify
              </div>
            </div>
            <div className="flex flex-col gap-6">
              <Button
                type="button"
                className="w-full"
                onClick={() => {
                  window.location.href = "mailto:";
                }}
              >
                Open email app
              </Button>
              <div className="text-center text-base group flex justify-center items-center gap-2 m-0 p-0 cursor-pointer">
                <ArrowLeft className="size-5 group-hover:text-primary/90" />
                <Link href="/login" className="group-hover:text-primary/90">
                  Back to login
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
