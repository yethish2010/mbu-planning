import { chromium } from 'playwright';

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:3008';
const EMAIL = process.env.SMOKE_EMAIL || 'admin@smartcampus.ai';
const PASSWORD = process.env.SMOKE_PASSWORD || 'admin123';

async function login(page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
}

async function assertWorkflowFilterChips(page) {
  await page.goto(`${BASE_URL}/bookings?requestType=Additional%20Room&assignment=unassigned`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.body.innerText.toLowerCase().includes('active workflow filters') || document.body.innerText.includes('No bookings found.'),
    { timeout: 30000, polling: 500 }
  );

  const bodyText = await page.evaluate(() => document.body.innerText);
  const normalizedBodyText = bodyText.toLowerCase();
  if (!normalizedBodyText.includes('active workflow filters')) {
    throw new Error('Expected workflow filter chips to be visible on the bookings page.');
  }
  if (!bodyText.includes('Request Type: Additional Room')) {
    throw new Error('Expected Request Type workflow chip to appear.');
  }
  if (!bodyText.includes('Assignment: Unassigned Only')) {
    throw new Error('Expected Assignment workflow chip to appear.');
  }
}

async function assertExpandedBookingStatuses(page) {
  await page.goto(`${BASE_URL}/bookings`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.body.innerText.includes('Awaiting Alternative Response') || document.body.innerText.includes('No bookings found.'),
    { timeout: 30000, polling: 500 }
  );

  const bodyText = await page.evaluate(() => document.body.innerText);
  const expectedStatuses = [
    'Awaiting Alternative Response',
    'No Room Available',
    'Waitlisted',
    'Clarification Required',
  ];

  for (const status of expectedStatuses) {
    if (!bodyText.includes(status)) {
      throw new Error(`Expected booking workflow status to be visible: ${status}`);
    }
  }
}

async function assertBookingLifecycleReport(page) {
  await page.goto(`${BASE_URL}/reports`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.body.innerText.includes('Booking Approvals') || document.body.innerText.includes('Report Generation'),
    { timeout: 30000, polling: 500 }
  );

  const reportTypeSelect = page.locator('select').filter({ has: page.locator('option[value="booking_lifecycle"]') }).first();
  await reportTypeSelect.selectOption('booking_lifecycle');
  await page.waitForTimeout(1000);

  const bodyText = await page.evaluate(() => document.body.innerText);
  const normalizedBodyText = bodyText.toLowerCase();
  const expectedLabels = [
    'Booking Workflow, Lead-Time & Resolution Trends',
    'No Room / Waitlist',
    'Need Clarification',
    'Alt Response Pending',
    'Open Workflow',
  ];

  for (const label of expectedLabels) {
    if (!normalizedBodyText.includes(label.toLowerCase())) {
      throw new Error(`Expected booking lifecycle report label to be visible: ${label}`);
    }
  }
}

async function assertFilterClear(page) {
  await page.goto(`${BASE_URL}/bookings?requestType=Additional%20Room&assignment=unassigned`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.body.innerText.toLowerCase().includes('active workflow filters') || document.body.innerText.includes('No bookings found.'),
    { timeout: 30000, polling: 500 }
  );
  const clearButton = page.getByRole('button', { name: 'Clear All Workflow Filters' });
  await clearButton.click();
  await page.waitForTimeout(1000);
  const currentUrl = page.url();
  if (currentUrl.includes('requestType=') || currentUrl.includes('assignment=')) {
    throw new Error(`Expected workflow filters to be cleared from the URL, got: ${currentUrl}`);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);

  try {
    console.log(`Logging into ${BASE_URL} as ${EMAIL}...`);
    await login(page);

    console.log('Checking workflow filter chips...');
    await assertWorkflowFilterChips(page);

    console.log('Checking expanded booking workflow statuses...');
    await assertExpandedBookingStatuses(page);

    console.log('Checking workflow filter clear action...');
    await assertFilterClear(page);

    console.log('Checking booking lifecycle reporting surface...');
    await assertBookingLifecycleReport(page);

    console.log('Smoke test passed: workflow filters, expanded statuses, and lifecycle reporting render correctly.');
  } catch (error) {
    console.error('Booking workflow smoke test failed.');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
