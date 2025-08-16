const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const { Cluster } = require('puppeteer-cluster');
const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
// Serve the index.html from the root directory
app.use(express.static(__dirname));

// Configuration
const config = {
  maxConcurrent: 4,
  timeout: 45000, // Increased timeout for potentially slow network
  retries: 2
};

// Global cluster
let cluster;

async function initCluster() {
  console.log('Initializing Puppeteer Cluster...');
  cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_PAGE,
    maxConcurrency: config.maxConcurrent,
    puppeteerOptions: {
      headless: 'new',
      // Removed hardcoded executablePath for better portability.
      // Puppeteer will download and use a compatible version of Chromium.
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    },
    timeout: config.timeout,
    retryLimit: config.retries
  });

  await cluster.task(async ({ page, data: code }) => {
    try {
      await page.setRequestInterception(true);
      page.on('request', req => {
        ['image', 'stylesheet', 'font'].includes(req.resourceType())
          ? req.abort()
          : req.continue();
      });

      await page.goto('https://www.rs.ge/ParcelSearch?cat=5&tab=1', {
        waitUntil: 'domcontentloaded',
        timeout: config.timeout
      });

      const token = await page.$eval('input[name="__RequestVerificationToken"]', el => el.value);

      const response = await page.evaluate(async (code, token) => {
        const res = await fetch("https://www.rs.ge/RsGe.Module/CargoVehicles/getSearchResults", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Referer": "https://www.rs.ge/ParcelSearch?cat=5&tab=1"
          },
          body: `searchType=6&searchValue=${encodeURIComponent(code)}&ena=geo&__RequestVerificationToken=${token}`
        });
        return await res.json();
      }, code, token);

      if (!response?.Data?.Rows?.length) {
        return { trackingCode: code, status: "Not Arrived" };
      }
      
      const result = { trackingCode: code, status: "In transit" };

      response.Data.Fields.forEach((field, i) => {
        if (!["ID", "GR_ID", "UN_ID"].includes(field)) {
          result[field] = response.Data.Rows[0][i];
        }
      });

      return result;
    } catch (error) {
      console.error(`Error processing tracking code ${code} on RS.ge:`, error);
      throw error;
    }
  });
  console.log('Puppeteer Cluster initialized successfully.');
}

initCluster().catch(err => console.error('Failed to initialize cluster:', err));

const parseShipments = async (page, url, defaultStatus) => {
  try {
    console.log(`Navigating to ${url} to parse shipments...`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    
    const parcelSelector = 'div.orange';
    
    await page.waitForSelector(parcelSelector, { timeout: 10000 }).catch(() => {
        console.log(`No parcels found on page: ${url}`);
        return [];
    });

    return await page.$$eval(parcelSelector, (parcels, status) => {
      return parcels.slice(0, 10).map(parcel => {
        const trackingAnchor = parcel.querySelector('a');
        if (!trackingAnchor) return null;

        const code = trackingAnchor.textContent.trim().replace(/^#\s*/, '');
        if (!/^[A-Z0-9]{6,}$/i.test(code)) return null;

        return {
          trackingCode: code,
          packageName: parcel.nextElementSibling?.textContent?.trim() || 'No description',
          status: status
        };
      }).filter(Boolean);
    }, defaultStatus);
  } catch (error) {
    console.error(`Error parsing shipments from ${url}:`, error.message);
    return [];
  }
};


app.post('/check', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  let browser;
  try {
    console.log('Launching browser for Boxette login...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox']
    });

    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(config.timeout);
    
    console.log('Navigating to Boxette login page...');
    await page.goto('https://profile1.boxette.ge/log-in', {
      waitUntil: 'domcontentloaded'
    });

    await page.type('#loginform-email', email);
    await page.type('#loginform-pass', password);

    console.log('Submitting login form...');
    await page.click("input[type='submit']");
    
    const successSelector = 'a[href*="/shipments/shipped"]';
    const errorSelector = '.error-summary, .has-error';

    try {
        console.log('Verifying login success...');
        await page.waitForSelector(successSelector, { timeout: 15000 });
        console.log('Login successful!');
    } catch (e) {
        console.error('Login failed. Could not find success selector.');
        return res.status(401).json({ error: 'Authentication failed. Please check your email and password.' });
    }

    // --- If login is successful, proceed to parse all shipment categories ---

const shipmentCategories = [
  { url: 'shipped', status: 'В пути' },
  { url: 'in-kiev', status: 'Ready to Pickup' },
  { url: 'received', status: 'In the Warehouse' }
];

const allShipments = (
  await Promise.all(
    shipmentCategories.map(cat =>
      parseShipments(page, `https://profile1.boxette.ge/profile/shipments/${cat.url}`, cat.status)
    )
  )
).flat();

    if (!allShipments.length) {
      console.log('No shipments found for this account across all categories.');
      return res.json([]);
    }
    
    console.log(`Found ${allShipments.length} total shipments. Checking status on RS.ge for those in transit...`);

    const results = await Promise.all(
      allShipments.map(item => {
        if (item.status === "В пути") {
          return cluster.execute(item.trackingCode)
            .then(rsData => ({ ...item, ...rsData }))
            .catch(error => ({
              ...item,
              status: "Ошибка",
              details: error.message
            }));
        }
        return Promise.resolve(item);
      })
    );

    console.log('Finished processing all shipments.');
    res.json(results);

  } catch (error) {
    console.error('An unexpected error occurred:', error);
    res.status(500).json({ error: 'An internal server error occurred: ' + error.message });
  } finally {
    if (browser) {
      console.log('Closing browser.');
      await browser.close();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server running on 192.168.0.105:${3000}`);
});
