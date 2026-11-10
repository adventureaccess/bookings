export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
      <p className="text-xs font-medium uppercase tracking-[0.3em] text-orange">
        Adventure Access
      </p>
      <h1 className="mt-6 text-5xl font-light sm:text-6xl">
        Bookings open soon.
      </h1>
      <p className="mt-6 max-w-md text-warm-mid">
        Small-group trips in Ladakh, Nepal, Bhutan and Yunnan. See the trips at{" "}
        <a
          className="text-dark underline decoration-orange underline-offset-4"
          href="https://adventure-access.com"
        >
          adventure-access.com
        </a>
        .
      </p>
    </main>
  );
}
