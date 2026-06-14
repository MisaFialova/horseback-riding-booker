import { Actor, log } from 'apify';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { setTimeout as sleep } from 'node:timers/promises';

chromium.use(StealthPlugin());

await Actor.init();

Actor.on('aborting', async () => {
    await sleep(1000);
    await Actor.exit();
});

const input = await Actor.getInput();
const {
    cookies = [],
    targetDays = [],
    targetTimes = [],
    instructors = [],
    classTypes = [],
    bookFromDate,
    bookUntilDate,
    bookingUrl = 'https://jezdeckyklub-elite.isportsystem.cz',
    dryRun = false,
} = input ?? {};

if (!cookies.length) {
    await Actor.fail('Missing required input: cookies must be a non-empty array. Export them from Chrome after logging in via Google.');
}
if (!targetDays.length || !targetTimes.length) {
    await Actor.fail('Missing required input: targetDays and targetTimes must each have at least one entry.');
}
if (!bookFromDate || !bookUntilDate) {
    await Actor.fail('Missing required input: bookFromDate and bookUntilDate are required (format: YYYY-MM-DD).');
}

const rangeStart = new Date(bookFromDate);
const rangeEnd = new Date(bookUntilDate);
rangeEnd.setHours(23, 59, 59, 999);

log.info('Starting horseback riding class booker', {
    targetDays, targetTimes, instructors, classTypes,
    bookFromDate, bookUntilDate, dryRun, cookieCount: cookies.length,
});

// Normalize day names — handles Czech and English
const DAY_ALIASES = {
    monday:    ['monday', 'pondělí', 'pondeli', 'po'],
    tuesday:   ['tuesday', 'úterý', 'utery', 'út'],
    wednesday: ['wednesday', 'středa', 'streda', 'st'],
    thursday:  ['thursday', 'čtvrtek', 'ctvrtek', 'čt'],
    friday:    ['friday', 'pátek', 'patek', 'pá'],
    saturday:  ['saturday', 'sobota', 'so'],
    sunday:    ['sunday', 'neděle', 'nedele', 'ne'],
};

function normalizeDay(day) {
    const lower = day.toLowerCase().trim();
    for (const [canonical, aliases] of Object.entries(DAY_ALIASES)) {
        if (aliases.includes(lower)) return canonical;
    }
    return lower;
}

function isTargetClass(dayText, timeText, classTypeText, instructorText) {
    const dayMatch = targetDays.some((d) => normalizeDay(d) === normalizeDay(dayText));
    const timeMatch = targetTimes.some((t) => timeText?.trim().startsWith(t.trim()));
    const classTypeMatch = !classTypes.length
        || classTypes.some((c) => classTypeText?.toLowerCase().includes(c.toLowerCase()));
    const instructorMatch = !instructors.length
        || instructors.some((i) => instructorText?.toLowerCase().includes(i.toLowerCase()));
    return dayMatch && timeMatch && classTypeMatch && instructorMatch;
}

const base = bookingUrl.replace(/\/$/, '');
const results = [];

const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'cs-CZ',
    viewport: { width: 1280, height: 800 },
    // Don't reveal that we're headless
    extraHTTPHeaders: {
        'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.8',
    },
});

// Mask webdriver flag
await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

const page = await context.newPage();

try {
    // Step 1 — inject session cookies so we're already logged in
    log.info('Injecting session cookies...', { count: cookies.length });
    await injectCookies(context, cookies, base);

    // Step 2 — load the site (cookies are now set, so we should be logged in)
    log.info('Opening site...', { url: base });
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Verify we're logged in (if login form is still showing, cookies have expired)
    const loginError = await page.$('.textWrapper a[href*="login"], .showAfterLogin');
    if (loginError) {
        log.warning('Login form still visible after injecting cookies — session may have expired. Re-export cookies from Chrome and update INPUT.json.');
    } else {
        log.info('Logged in successfully via cookies');
    }

    // Step 3 — iterate week by week through the booking range, book all matching slots
    let weekStart = new Date(rangeStart);
    // Snap to Monday of that week
    const dayOfWeek = weekStart.getDay();
    weekStart.setDate(weekStart.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));

    let weekNumber = 0;
    while (weekStart <= rangeEnd) {
        weekNumber++;
        log.info(`Scanning week ${weekNumber}`, { weekOf: weekStart.toISOString().slice(0, 10) });
        await navigateToWeek(page, weekStart);
        await findAndBookClasses(page, base, dryRun, results);

        // Advance to next Monday
        weekStart = new Date(weekStart);
        weekStart.setDate(weekStart.getDate() + 7);
        await sleep(1000);
    }

    log.info(`Finished scanning ${weekNumber} week(s)`);

} catch (err) {
    log.exception(err, 'Actor failed');

    // Save a screenshot and the page HTML for debugging
    const screenshot = await page.screenshot({ fullPage: true }).catch(() => null);
    if (screenshot) {
        await Actor.setValue('error_screenshot.png', screenshot, { contentType: 'image/png' });
        log.info('Saved error screenshot to key-value store as "error_screenshot.png"');
    }
    const html = await page.content().catch(() => null);
    if (html) {
        await Actor.setValue('error_page.html', html, { contentType: 'text/html' });
        log.info('Saved error page HTML to key-value store as "error_page.html"');
    }
    await Actor.fail(err.message);
} finally {
    await browser.close();
}

await Actor.pushData(results);
log.info('Done', { totalBooked: results.filter((r) => r.booked).length, totalFound: results.length });
await Actor.exit();

// ---------------------------------------------------------------------------

async function navigateToWeek(page, monday) {
    const d = monday.getDate();
    const m = monday.getMonth() + 1;
    const y = monday.getFullYear();

    // iSportSystem loads schedule via jQuery AJAX into the tab panel.
    // Trigger it directly via the same endpoint the tab uses.
    await page.evaluate(({ day, month, year }) => {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('AJAX timeout')), 10000);
            $.ajax({
                url: 'ajax/ajax.schema.php',
                data: { day, month, year, id_sport: 5, event: 'pageLoad', tab_type: 'activity', timetableWidth: 970, schema_fixed_date: '' },
                success(data) {
                    clearTimeout(timeout);
                    const panel = document.querySelector('.ui-tabs-panel:not([aria-hidden="true"]), #ui-id-2');
                    if (panel) panel.innerHTML = data;
                    resolve();
                },
                error(xhr) {
                    clearTimeout(timeout);
                    reject(new Error(`AJAX error: ${xhr.status}`));
                },
            });
        });
    }, { day: d, month: m, year: y });

    await sleep(800);
}

async function injectCookies(browserContext, rawCookies, base) {
    const url = new URL(base);

    // Normalize cookies from Cookie-Editor export format to Playwright format
    const normalized = rawCookies.map((c) => {
        const cookie = {
            name: c.name,
            value: c.value,
            domain: c.domain ?? url.hostname,
            path: c.path ?? '/',
            secure: c.secure ?? false,
            httpOnly: c.httpOnly ?? false,
            sameSite: normalizeSameSite(c.sameSite),
        };
        // Cookie-Editor uses 'expirationDate'; Playwright uses 'expires'
        if (c.expirationDate) cookie.expires = Math.floor(c.expirationDate);
        else if (typeof c.expires === 'number') cookie.expires = Math.floor(c.expires);
        return cookie;
    });

    await browserContext.addCookies(normalized);
    log.info('Cookies injected', { count: normalized.length });
}

function normalizeSameSite(value) {
    if (!value) return 'Lax';
    const v = value.toString().toLowerCase();
    if (v === 'strict') return 'Strict';
    if (v === 'none') return 'None';
    return 'Lax';
}

async function findAndBookClasses(page, base, dry, results) {
    log.info('Scanning schedule for target classes...');

    // Wait for the AJAX schedule to finish loading
    await page.waitForSelector('a.slot', { timeout: 15000 }).catch(() => {
        log.warning('No slots found on page — schedule may still be loading');
    });
    await sleep(1500);

    const scheduleHtml = await page.content();
    await Actor.setValue('schedule_page_debug.html', scheduleHtml, { contentType: 'text/html' });

    // Slots are <a class="tooltip slot [fullyBooked|waitingOnly]" rel="act|sportId|laneId|actId|startTs|endTs|price">
    // Only target slots that are actually bookable (no fullyBooked, no waitingOnly)
    const slots = await page.$$('a.slot:not(.fullyBooked):not(.waitingOnly)');
    log.info(`Found ${slots.length} bookable slot(s) on current week view`);

    for (const slot of slots) {
        const timeText = await slot.$eval('.time', (el) => el.textContent.trim()).catch(() => '');
        const rel = await slot.getAttribute('rel') ?? '';
        const titleAttr = await slot.getAttribute('title') ?? '';

        // rel format: "act|sportId|laneId|actId|startTimestamp|endTimestamp|price"
        const startTs = parseInt(rel.split('|')[4], 10);
        const slotDate = startTs ? new Date(startTs * 1000) : null;

        // Parse day name from the tooltip title HTML using DOMParser (handles &nbsp; correctly).
        // The title attribute contains inner HTML like: <div class="tItem2">Pondělí 15.6.2026</div>
        const dayFromTitle = await slot.evaluate((el) => {
            const title = el.getAttribute('title');
            if (!title) return '';
            const doc = new DOMParser().parseFromString(title, 'text/html');
            for (const item of doc.querySelectorAll('.tItem2')) {
                const text = item.textContent.trim();
                if (/\d+\.\d+\.\d+/.test(text)) {
                    // "Pondělí 15.6.2026" — return the part before the date
                    return text.replace(/\s*\d+\.\d+\.\d+.*/, '').trim();
                }
            }
            return '';
        });
        const dayOfWeek = dayFromTitle ? normalizeDay(dayFromTitle) : '';

        // Time span contains "18:00–19:00" — extract the start time
        const startTime = timeText.split('–')[0].trim();
        const name = await slot.$eval('.name', (el) => el.textContent.trim()).catch(() => '');
        const instructor = await slot.$eval('.instructor', (el) => el.textContent.trim()).catch(() => '');

        log.debug('Slot', { day: dayOfWeek, time: startTime, name, instructor, date: slotDate?.toISOString().slice(0, 10) });

        if (!isTargetClass(dayOfWeek, startTime, name, instructor)) continue;

        // Only book slots within the configured date range
        if (slotDate && (slotDate < rangeStart || slotDate > rangeEnd)) {
            log.debug('Slot outside booking range — skipping', { day: dayOfWeek, time: startTime, slotDate: slotDate.toISOString().slice(0, 10) });
            continue;
        }
        log.info('Found target slot!', { day: dayOfWeek, time: startTime, name, instructor });

        if (dry) {
            log.info('[DRY RUN] Would book this slot');
            results.push({ day: dayOfWeek, time: startTime, name, instructor, available: true, booked: false, dryRun: true });
            continue;
        }

        // Click slot — iSportSystem opens a jQuery UI dialog with booking form
        await slot.evaluate((el) => el.click());
        await sleep(1500);

        // Find and click the confirm/book button inside the dialog
        const confirmBtn = await findElement(page, [
            '.ui-dialog input[name="vybrat"]',
            '.ui-dialog input[name="rezervovat"]',
            '.ui-dialog button:has-text("Rezervovat")',
            '.ui-dialog button:has-text("Potvrdit")',
            '.ui-dialog button:has-text("Vybrat")',
            '.ui-dialog input[type="submit"]',
        ]);

        if (!confirmBtn) {
            // Save dialog HTML for inspection
            const dialogHtml = await page.$eval('.ui-dialog', (el) => el.outerHTML).catch(() => '');
            await Actor.setValue('booking_dialog_debug.html', dialogHtml, { contentType: 'text/html' });
            log.warning('No booking confirm button found in dialog — check "booking_dialog_debug.html"', { day: dayOfWeek, time: startTime });
            results.push({ day: dayOfWeek, time: startTime, name, instructor, available: true, booked: false, error: 'No confirm button in dialog' });
            await page.keyboard.press('Escape');
            continue;
        }

        await confirmBtn.click();
        await sleep(2000);

        log.info('Successfully booked!', { day: dayOfWeek, time: startTime, name, instructor });
        results.push({ day: dayOfWeek, time: startTime, name, instructor, available: true, booked: true });
        await sleep(2000);
    }
}

async function findElement(page, selectors) {
    for (const selector of selectors) {
        const el = await page.$(selector).catch(() => null);
        if (el) return el;
    }
    return null;
}

