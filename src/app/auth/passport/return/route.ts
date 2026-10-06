import { PASSPORT_CALLBACK_HTML } from '@/libs/passport/passport-callback';

export function GET() {
  return new Response(PASSPORT_CALLBACK_HTML, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
