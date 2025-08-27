"use client"
import { Button } from "@/components/ui/button"
import { useEffect, useLayoutEffect, useState } from "react"
import { SiGmail } from "react-icons/si";
import { PiMicrosoftOutlookLogoFill } from "react-icons/pi";
import { FaYahoo } from "react-icons/fa";
import { BsEnvelope } from "react-icons/bs";

export default function VerificationPage() {

  const emailProviders = [
    {
      name: "Open Gmail",
      icon: SiGmail,
      url: "https://gmail.com/",
    },
    {
      name: "Open Outlook",
      icon: PiMicrosoftOutlookLogoFill,
      url: "https://outlook.live.com/",
    },
    {
      name: "Open Yahoo!",
      icon: FaYahoo,
      url: "https://mail.yahoo.com/",
    },
    {
      name: "Open Apple Mail",
      icon: BsEnvelope,
      url: "https://icloud.com/mail",
    },
  ]

  return (
    <div className="bg-muted min-h-screen flex items-center justify-center p-4">
      <div className="max-w-2xl w-full space-y-8">
        {/* Main heading */}
        <h1 className="text-4xl font-normal leading-tight">Great, now please verify your email</h1>

        {/* Subtext */}
        <p className="text-lg leading-relaxed">
          Once verified, you will be able to access <span className="font-medium">berry.me</span>.
        </p>

        {/* Email provider buttons */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4">
          {emailProviders.map((provider) => (
            <Button
              key={provider.name}
              variant="outline"
              size="lg"
              className="h-14 gap-4 text-lg font-normal"
              onClick={() => window.open(provider.url, "_blank")}
              resizeSVG={false}
            >

                <provider.icon size={20}/>
              {provider.name}
            </Button>
          ))}
        </div>

        {/* Footer text */}
        {/* <p className=" pt-8">
          {"Didn't receive an email? Check your spam folder or "}
          <Button
          className="p-0 m-0 font-medium"
          type="button"
          variant={"link"}
            onClick={() => {
              // Handle resend email logic here
              console.log("Resending email...")
            }}
          >
            resend email
          </Button>
          .
        </p> */}
      </div>
    </div>
  )
}
