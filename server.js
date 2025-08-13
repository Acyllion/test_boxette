const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const { Cluster } = require('puppeteer-cluster');
const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Конфигурация
const config = {
  maxConcurrent: 4,
  timeout: 30000,
  retries: 2
};

// Глобальный кластер
let cluster;

async function initCluster() {
  cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_PAGE,
    maxConcurrency: config.maxConcurrent,
    puppeteerOptions: {
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    },
    timeout: config.timeout
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

      const result = { trackingCode: code, status: "In transit" }; // Изменено с "Найдено" на "In transit"

      response.Data.Fields.forEach((field, i) => {
        if (!["ID", "GR_ID", "UN_ID"].includes(field)) {
          result[field] = response.Data.Rows[0][i];
        }
      });

      return result;
    } catch (error) {
      throw error;
    }
  });
}

initCluster().catch(console.error);

// Функция для парсинга посылок
const parseShipments = async (page, url, defaultStatus) => {
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  try {
    return await page.$$eval('div.orange a', (anchors, status) => {
      return Array.from(anchors).slice(0, 10).map(a => {
        const code = a.textContent.trim().replace(/^#\s*/, '');
        if (!/^[A-Z0-9]+$/i.test(code)) return null;

        return {
          trackingCode: code,
          packageName: a.closest('div.orange')?.nextElementSibling?.textContent?.trim() || '',
          status: status
        };
      }).filter(Boolean);
    }, defaultStatus);
  } catch (error) {
    console.error(`Error parsing ${url}:`, error);
    return [];
  }
};

app.post('/check', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Требуется email и пароль' });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: ['--no-sandbox']
    });

    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(config.timeout);

    // Логин в Boxette
    await page.goto('https://profile1.boxette.ge/log-in', {
      waitUntil: 'domcontentloaded',
      timeout: config.timeout
    });

    await page.$eval('#loginform-email', (el, email) => el.value = email, email);
    await page.$eval('#loginform-pass', (el, pass) => el.value = pass, password);

    await Promise.all([
      page.click("input[type='submit']"),
      page.waitForNavigation({ waitUntil: 'domcontentloaded' })
    ]);

    // Парсим оба типа посылок
    const shippedShipments = await parseShipments(
      page,
      'https://profile1.boxette.ge/profile/shipments/shipped',
      'В пути'
    );

    const readyShipments = await parseShipments(
      page,
      'https://profile1.boxette.ge/profile/shipments/in-kiev',
      'Ready to Pickup'
    );

    const allShipments = [...shippedShipments, ...readyShipments];

    if (!allShipments.length) {
      return res.json([]);
    }

    // Проверяем только посылки "В пути" на RS.ge
    const results = await Promise.all(
      allShipments.map(item => {
        if (item.status === "В пути") {
          return cluster.execute(item.trackingCode)
            .then(data => ({ ...item, ...data }))
            .catch(error => ({
              ...item,
              status: "Ошибка",
              details: error.message
            }));
        }
        return Promise.resolve(item);
      })
    );

    res.json(results);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
