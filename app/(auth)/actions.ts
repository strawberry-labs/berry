'use server';
import { auth, signIn, signOut } from './auth';

// For Email Magic Link
export const emailMagicLink = async (email: string) => {
  await signIn('email', { email, redirect: true });
  return { status: 'success' };
};

// For OAuth
export const oauthSignIn = async (provider: 'github' | 'google' | 'apple') => {
  await signIn(provider, { redirect: true});
  return { status: 'success' };
};

//For guest
export const guestSignIn = async () =>{
  await signIn('guest', {redirect:true, redirectTo:"/"})
  return { status: 'success' };
}
