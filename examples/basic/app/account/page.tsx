import { SubscribeForm } from './subscribe-form';

export default function Account() {
  return (
    <>
      <h1>Account</h1>
      <p>A Server Action protected by schema validation and rate limiting.</p>
      <SubscribeForm />
    </>
  );
}
