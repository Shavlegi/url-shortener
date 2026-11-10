# ბმულების შემოკლება (URL Shortener)

ნეიტრალური, უფასო, თვით-ჰოსტინგის ბმულების შემოკლება — **Cloudflare Workers + Cloudflare D1**,
ქართული ინტერფეისით, QR კოდებით და კლიკების სტატისტიკით. ვიზიტორების შესახებ
**არანაირი მონაცემი არ ინახება** (არც IP, არც ქუქი-თრექინგი).

> **English summary:** A free, self-hosted URL shortener on Cloudflare Workers + D1,
> with a Georgian admin UI, QR codes and click stats. No visitor tracking of any kind.
> Admin login uses PBKDF2-SHA256 + server-side sessions. See SECURITY.md for the
> threat model and known limitations.

## შესაძლებლობები

- ბმულების შემოკლება — ავტომატური 6-სიმბოლოიანი სახელი ან თქვენი სახელი (3–32 სიმბოლო)
- სახელის ხელმისაწვდომობის შემოწმება და დუბლიკატების აკრძალვა
- QR კოდი ყველა ბმულზე (ბრაუზერში გენერირდება, PNG გადმოწერა)
- ბმულების სია: ძებნა, კოპირება, ჩართვა/გამორთვა, წაშლა, ვადის დაყენება
- კლიკების მთვლელი (D1-ში ატომური `UPDATE ... SET clicks = clicks + 1`)
- ექსპორტი/იმპორტი JSON-ით (ბექაფი და აღდგენა)
- ადმინის შესვლა პაროლით (PBKDF2-SHA256, სერვერული სესია, HttpOnly cookie)
- Rate limiting — IP-ის SHA-256 ჰეშით (თავად IP არსად ინახება)
- მხოლოდ `https://` დანიშნულება; სახიფათო სქემები, localhost, შიდა IP-ები,
  სხვა shortener-ები და საეჭვო დომენები იბლოკება

## ფაილების სტრუქტურა

```
url-shortener/
├── README.md                  # ეს დოკუმენტი
├── SECURITY.md                # უსაფრთხოების მოდელი და ლიმიტები
├── .dev.vars.example          # ლოკალური ცვლადების ნიმუში (რეალური მნიშვნელობების გარეშე)
├── .gitignore
├── package.json               # wrangler + npm სკრიპტები
├── wrangler.toml              # Worker + D1 binding + Static Assets
├── migrations/
│   └── 0001_init.sql          # D1 სქემა: links, sessions, rate_limits
├── public/                    # ფრონტენდი (Cloudflare Static Assets-ით)
│   ├── index.html             # ქართული UI — შესვლა + ადმინის დეშბორდი
│   ├── styles.css             # დიზაინი (ფერები CSS ცვლადებია — იოლად იცვლება)
│   ├── app.js                 # დეშბორდის ლოგიკა
│   └── qrcode.min.js          # QR ბიბლიოთეკა (vendored, qrcode-generator 1.4.4)
├── src/
│   └── index.js               # Worker: როუტინგი, API, ავტორიზაცია, რედირექტი
├── scripts/
│   ├── build-single-file.js   # აგებს dist/worker-single-file.js (Quick Edit-ისთვის)
│   └── make-hash.html         # ადმინის პაროლის ჰეშის გენერატორი (ბრაუზერში)
└── dist/                      # გენერირებული (git-ში არ იტვირთება)
    └── worker-single-file.js  # ერთი ფაილი — დეშბორდში ჩასაკოპირებლად
```

## უფასო ტარიფის ლიმიტები (Cloudflare, 2026)

- **Workers:** დღეში 100,000 მოთხოვნა უფასოა.
- **D1:** 5 GB მონაცემები, დღეში 5 მლნ წაკითხვა / 100,000 ჩაწერა უფასოა.
- **Static Assets:** უფასოა.
- ერთადერთი ფასიანი რამ მომავალში იქნება **დომენი** (თუ მოინდომებთ) — თავად აპი
  სრულად უფასოა და თავიდან `*.workers.dev` მისამართზე იმუშავებს.

## დაყენება — ნაბიჯ-ნაბიჯ

### 1. GitHub რეპოზიტორია

1. შექმენით ცარიელი **public** რეპო, სახელი: `url-shortener`
   (`https://github.com/new` — README/LICENSE/.gitignore არ მონიშნოთ).
2. ატვირთეთ ამ პროექტის ფაილები (ბრაუზერით ან `git push`-ით).
3. **არასოდეს** ატვირთოთ რეალური პაროლები, ჰეშები ან secret-ები.

### 2. Cloudflare ანგარიში

1. შექმენით უფასო ანგარიში: https://dash.cloudflare.com/sign-up
   (იმეილი + პაროლი, მეილის დადასტურება).
2. ბარათი არ გჭირდებათ — უფასო ტარიფისთვის არაფერს ითხოვს.

### 3. D1 ბაზის შექმნა (ტერმინალიდან — wrangler)

```bash
npm install
npx wrangler d1 create url-shortener-db
```

ბრძანება დაბეჭდავს `database_id`-ს — ჩასვით `wrangler.toml`-ში
(`REPLACE_WITH_YOUR_D1_DATABASE_ID`-ის ნაცვლად) და დააკომიტეთ.

მერე მიგრაციის გაშვება:

```bash
npx wrangler d1 migrations apply url-shortener-db --remote
```

> დეშბორდიდან (ტერმინალის გარეშე): Cloudflare dashboard → **Workers & Pages** →
> **D1** → **Create database** (სახელი: `url-shortener-db`) → გახსენით ბაზა →
> **Console** ჩანართში ჩასვით `migrations/0001_init.sql`-ის შიგთავსი და გაუშვით.

### 4. ადმინის პაროლის ჰეში

1. გახსენით `scripts/make-hash.html` ბრაუზერში (ფაილი თქვენს კომპიუტერში/ტელეფონში).
2. ჩაწერეთ ძლიერი პაროლი (მინ. 12 სიმბოლო) და დააჭირეთ „ჰეშის შექმნა".
3. დაკოპირებული ჰეში (`pbkdf2$100000$...`) **არ შეინახოთ არსად** — პირდაპირ
   ჩასვით Cloudflare secret-ად (შემდეგი ნაბიჯი). პაროლი თავად დაიმახსოვრეთ.

### 5. Secrets (Cloudflare)

ტერმინალიდან:

```bash
npx wrangler secret put ADMIN_PASSWORD_HASH   # ჩასვით ჰეში მე-4 ნაბიჯიდან
npx wrangler secret put SESSION_SECRET        # გრძელი შემთხვევითი სტრიქონი, მინ. 32 სიმბოლო
```

> დეშბორდიდან: Worker → **Settings** → **Variables** → **Add variable** →
> ტიპი **Secret** → სახელი + მნიშვნელობა → **Save**.

`SESSION_SECRET`-ის გენერირება (თუ კომპიუტერი გაქვთ):

```bash
openssl rand -hex 32
```

### 6. დეპლოი — გზა A: wrangler (რეკომენდებული)

```bash
npx wrangler deploy
```

წარმატების შემდეგ მიიღებთ მისამართს, მაგ. `https://url-shortener.<თქვენი-სახელი>.workers.dev`.

### 6. დეპლოი — გზა B: დეშბორდი, Git-დან (ტერმინალის გარეშე)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Connect to Git**.
2. აირჩიეთ GitHub რეპო `url-shortener` და დააკავშირეთ.
3. Build settings: framework preset — **None** (ან დატოვეთ ცარიელი); Build command —
   ცარიელი; Deploy command — `npx wrangler deploy`.
4. **Settings → Variables**-ში დაამატეთ:
   - D1 binding: **D1 Database Bindings** → ცვლადის სახელი `DB` → აირჩიეთ `url-shortener-db`
   - Secrets: `ADMIN_PASSWORD_HASH`, `SESSION_SECRET` (მე-5 ნაბიჯი)
5. **Deploy** — Cloudflare თავად ააგებს და გაუშვებს Worker-ს.

### 6. დეპლოი — გზა C: დეშბორდი, ერთი ფაილის ჩასმა (Quick Edit)

1. გაუშვით `npm run build:single` (ქმნის `dist/worker-single-file.js`-ს).
2. Dashboard → **Workers & Pages** → **Create Worker** → **Quick Edit**.
3. ჩასვით `dist/worker-single-file.js`-ის შიგთავსი და დააჭირეთ **Deploy**.
4. **Settings → Variables**-ში დაამატეთ D1 binding (`DB` → `url-shortener-db`)
   და ორი secret-ი (მე-5 ნაბიჯი), მერე **Redeploy**.

> გზა C-ში ფრონტენდი Worker-ის შიგნითაა ჩაშენებული — განახლებისას ფაილი
> ხელახლა უნდა ააგოთ და ჩასვათ. გზა A/B ავტომატურია.

## პირველი შესვლა და ტესტირება

1. გახსენით Worker-ის მისამართი (`*.workers.dev`).
2. შედით ადმინის პაროლით (მე-4 ნაბიჯში მოფიქრებული).
3. შექმენით სატესტო ბმული, მაგ. `https://example.com` → გახსენით მოკლე ბმული
   ახალ ჩანართში → დარწმუნდით, რომ გადამისამართდა და კლიკების რიცხვი 1-ით გაიზარდა.
4. შეამოწმეთ: არასწორი პაროლი (უნდა უარყოს), არასწორი ბმული (`http://`,
   `javascript:`), დუბლიკატი სახელი, QR კოდის PNG გადმოწერა, ბმულის გამორთვა
   (უნდა დააბრუნოს 410), წაშლა, ექსპორტი/იმპორტი.

სრული სატესტო სია: იხ. SECURITY.md-ის ბოლო ნაწილი და სპეციფიკაცია.

## პაროლის აღდგენა (თუ დაგავიწყდათ)

პაროლის აღდგენის მეილი **არ არსებობს** — ასეა ჩაფიქრებული (უსაფრთხოება).
აღდგენა:

1. გახსენით `scripts/make-hash.html`, შექმენით ახალი პაროლის ჰეში.
2. Cloudflare dashboard → Worker → **Settings → Variables** → `ADMIN_PASSWORD_HASH`
   secret-ის მნიშვნელობა ახლით ჩაანაცვლეთ → **Save** → **Redeploy** (თუ საჭიროა).
3. შედით ახალი პაროლით. ძველი სესიები ავტომატურად ძალადაკარგული არ არის —
   თუ გინდათ, D1-ში `DELETE FROM sessions;` გაუშვით Console-დან.

## ბექაფი

- **ექსპორტი:** დეშბორდში ღილაკი „ექსპორტი (JSON)" — ჩამოტვირთავს ყველა ბმულს.
- **იმპორტი:** ღილაკი „იმპორტი (JSON)" — აღადგენს ფაილიდან (არსებული სახელები
  გამოტოვება, დუბლიკატები არ იქმნება).
- შეინახეთ ბექაფი უსაფრთხო ადგილას (მაგ. თქვენს ტელეფონში/Drive-ში).

## ბრენდი და დომენი — მერე

- **სახელი/ლოგო/ფერები:** ფერები `public/styles.css`-ის `:root` ცვლადებია;
  სათაური `public/index.html`-შია. შეცვალეთ და ხელახლა დადეპლოით.
- **დომენი:** როცა იყიდით, Cloudflare dashboard → Worker → **Settings →
  Custom Domains** → **Add Custom Domain**. მოკლე ბმულები ავტომატურად
  ახალი დომენით დაიწყებს მუშაობას (კოდის ცვლილება არ სჭირდება).
- მოკლე სახელის ფორმატი (6 სიმბოლო) `src/index.js`-ის `CONFIG`-ში იცვლება.

## ლოკალური გაშვება (ტესტირებისთვის)

```bash
cp .dev.vars.example .dev.vars   # შეავსეთ რეალური მნიშვნელობებით (ლოკალურად მხოლოდ!)
npm install
npx wrangler d1 migrations apply url-shortener-db --local
npx wrangler dev
```

გაიხსნება `http://localhost:8787` (შესვლის cookie ლოკალურად მუშაობს, რადგან
Worker `Secure` ნიშანს მხოლოდ `https://` მოთხოვნებზე სვამს).
