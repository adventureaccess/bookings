-- Milestone payments: each departure can list payments due between the
-- deposit and the final balance. Amounts are integer cents per person.
-- Shape: [{ "id": "p1", "label": "Second payment", "due_date": "2027-03-01", "amount_cents": 150000 }]
-- The final balance (total minus paid) stays due on balance_due_date.

alter table public.departures
  add column payment_schedule jsonb not null default '[]'::jsonb,
  add constraint departures_payment_schedule_array check (
    jsonb_typeof(payment_schedule) = 'array'
  );

comment on column public.departures.payment_schedule is
  'Scheduled payments per person between the deposit and the final balance. Integer cents.';
