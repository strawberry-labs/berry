"use client"
import { Button } from "@/components/ui/button"
import { useState } from "react"
import { useSearchParams } from "next/navigation";
import { emailMagicLink } from "../actions";
import { GmailIcon, OutlookIcon, YahooIcon } from "@/components/icons";
import Image from "next/image";

  const emailProviders = [
    {
      name: "Open Gmail",
      icon: GmailIcon,
      url: "https://gmail.com/",
    },
    {
      name: "Open Outlook",
      icon: OutlookIcon,
      url: "https://outlook.live.com/",
    },
    {
      name: "Open Yahoo!",
      icon: YahooIcon,
      url: "https://mail.yahoo.com/",
    },
    {
      name: "Open Apple Mail",
      icon: "/images/apple_mail.svg",
      url: "https://icloud.com/mail",
    },
  ]

export default function VerificationPage() {

  const searchParams = useSearchParams();

  const [isCooldown, setIsCooldown] = useState(false);

  const email = searchParams.get('email');

  async function handleResendEmail(email:string){
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if(email && emailRegex.test(email)){
      if (isCooldown){
        return;
      }
      console.log("Resending email...")
      setIsCooldown(true);
      await emailMagicLink(email)
      setTimeout(() => setIsCooldown(false), 60000);
    }
  }

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
            >

            {typeof provider.icon === "string"
                ? <Image src={provider.icon} width={30} height={30} alt="Apple Mail Icon"/>
                : <provider.icon size={30}/>}
              {provider.name}
            </Button>
          ))}
        </div>

        {/* Footer text */}
        <p className=" pt-8">
          {"Didn't receive an email? Check your spam folder or "}
          <Button
          className="p-0 m-0 font-medium"
          type="button"
          variant={"link"}
            onClick={() => {
              // Handle resend email logic here
              handleResendEmail(email||"")
            }}
          >
            resend email
          </Button>
          .
        </p>
      </div>
    </div>
  )
}
