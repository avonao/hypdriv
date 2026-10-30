import type { Metadata } from 'next';
import { ContactForm } from './contact-form';

export const metadata: Metadata = { title: 'Contact' };

export default function ContactPage() {
  return (
    <>
      <h1>Contact</h1>
      <p>A Server Action validated by Zod, rate limited per IP and handed to a queue with enqueue().</p>
      <ContactForm />
    </>
  );
}
