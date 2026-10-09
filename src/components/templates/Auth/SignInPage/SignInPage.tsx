import { Container } from '@/atoms/Container/Container';
import { SignInContent, SignInFooter } from '@/organisms/SignIn/SignIn';
import { SignInNavigation } from '@/organisms/SignInNavigation/SignInNavigation';

export function SignInPage() {
  return (
    <Container size="container" className="max-w-screen-xl px-6 lg:px-10">
      <SignInContent />
      <SignInFooter />
      <SignInNavigation />
    </Container>
  );
}
