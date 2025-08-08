import { redirect } from 'next/navigation';

import { LoginForm } from '@/components/login-form';
import { auth } from '../auth';

export default async function Page() {

  const session = await auth();

  if(session){
    redirect('/')
  }

  return (
    <div className="bg-muted flex min-h-svh flex-col items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm md:max-w-[24 rem]">
        <LoginForm />
      </div>
    </div>
  )
}
