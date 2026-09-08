import type { Metadata } from "next";
import { Fraunces, Hanken_Grotesk } from "next/font/google";
import "./globals.css";

// Display serif con carácter editorial — para titulares y la marca.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  display: "swap",
});

// Grotesk refinada para el cuerpo y la UI.
const hanken = Hanken_Grotesk({
  variable: "--font-hanken",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Turnos — Reservas online para profesionales",
    template: "%s · Turnos",
  },
  // Lo que Google indexa y lo primero que alguien lee de nosotros. Nombra
  // sólo lo que el producto hace hoy: Stripe y los recordatorios por WhatsApp
  // están anunciados en la home como próximamente, y un resultado de búsqueda
  // no tiene dónde poner ese matiz.
  description:
    "La plataforma de reservas para tu negocio. Calendario, agenda online y cobros con Mercado Pago. Todo en tu marca.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="es"
      className={`${fraunces.variable} ${hanken.variable} h-full antialiased`}
    >
      <body className="relative min-h-full font-sans">
        {/* Capas de atmósfera: mesh dorado + grano de película. */}
        <div className="bg-mesh pointer-events-none fixed inset-0 -z-10" />
        <div className="noise" />
        {children}
      </body>
    </html>
  );
}
