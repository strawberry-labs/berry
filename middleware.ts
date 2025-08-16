import { NextResponse, type NextRequest } from 'next/server';
import { isDevelopmentEnvironment } from './lib/constants';
import { getToken } from 'next-auth/jwt';

//routes in which are protected. A guest user will be generated if no token is found
const protectedRoutes: string[] = ['/', '/chat']

//routes in which only unauthenticated and guest users are allowed
const guestRoutes: string[] = ['/login', '/check-email']

//routes in which only regular users are allowed
const regularRoutes: string[] = [];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  /*
   * Playwright starts the dev server and requires a 200 status to
   * begin the tests, so this ensures that the tests can start
   */
  if (pathname.startsWith('/ping')) {
    return new Response('pong', { status: 200 });
  }

  if (pathname.startsWith('/api/auth')) {
    return NextResponse.next();
  }

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  const isProtectedRoute = protectedRoutes.some((route)=> route==='/' ? pathname==='/' : pathname.startsWith(route))

  if(isProtectedRoute && !token){
    const redirectUrl = encodeURIComponent(request.url);

    return NextResponse.redirect(
      new URL(`/api/auth/guest?redirectUrl=${redirectUrl}`, request.url),
    );
  }

  const isGuest = token?.type === null || token?.type === "guest"

  const isGuestRoute = guestRoutes.some((route)=> route==='/' ? pathname==='/' : pathname.startsWith(route))

  if (token && !isGuest && isGuestRoute) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  const isRegularRoute = regularRoutes.some((route)=> route==='/' ? pathname==='/' : pathname.startsWith(route))

  if(token && isGuest && isRegularRoute){
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/',
    '/chat',
    '/chat/:id',
    '/api/:path*',
    '/login',
    '/check-email',
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico, sitemap.xml, robots.txt (metadata files)
     */
    '/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)',
  ],
};
