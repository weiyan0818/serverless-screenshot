// Vercel 不會設定 AWS_LAMBDA_JS_RUNTIME，@sparticuz/chromium 只在偵測到
// Lambda 時才解出 al2023.tar.br（內含 libnss3.so）並設定 LD_LIBRARY_PATH。
// 這個判斷在套件載入當下執行，所以必須寫在 require 之前。
if (process.env.VERCEL && !process.env.AWS_LAMBDA_JS_RUNTIME) {
  process.env.AWS_LAMBDA_JS_RUNTIME = 'nodejs20.x';
}

const fs = require('node:fs');
const path = require('node:path');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const cloudinary = require('cloudinary').v2;

const CJK_FONT_URL =
  'https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Regular.otf';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

chromium.setGraphicsMode = false;

const installCjkFont = async (executablePathReady) => {
  const fileName = await chromium.font(CJK_FONT_URL);
  await executablePathReady;

  const home = process.env.HOME || '/tmp';
  const source = path.join(home, '.fonts', fileName);
  const fontDir = process.env.FONTCONFIG_PATH || '/tmp/fonts';
  fs.mkdirSync(fontDir, { recursive: true });
  const dest = path.join(fontDir, fileName);
  if (fs.existsSync(source) && !fs.existsSync(dest)) {
    fs.copyFileSync(source, dest);
  }
};

const uploadFromBuffer = (buffer) => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "social-images",
        resource_type: "image",
        format: "jpg",
      },
      (error, result) => {
        if (result) resolve(result);
        else reject(error);
      }
    );
    uploadStream.write(buffer);
    uploadStream.end();
  });
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { htmlList } = req.body;

  if (!htmlList || !Array.isArray(htmlList) || htmlList.length === 0) {
    return res.status(400).json({ error: '請提供有效的 htmlList 陣列' });
  }

  let browser = null;

  try {
    const executablePathReady = chromium.executablePath();
    await installCjkFont(executablePathReady).catch((error) => {
      console.error('CJK font load failed:', error);
    });

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--disable-font-subsetting',
        '--font-render-hinting=none',
      ],
      defaultViewport: { width: 1000, height: 1000, deviceScaleFactor: 2 },
      executablePath: await executablePathReady,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const imageUrls = new Array(htmlList.length);
    await Promise.all(
      htmlList.map(async (html, index) => {
        const page = await browser.newPage();
        try {
          await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await page.addStyleTag({
            content: `
              @font-face {
                font-family: "Noto Sans TC";
                src: local("Noto Sans CJK TC"), local("Noto Sans CJK TC Regular"), local("Noto Sans TC");
                font-weight: 100 900;
                font-style: normal;
                font-display: block;
              }
            `,
          });
          await page.evaluate(async () => {
            await document.fonts.ready;
          });
          await new Promise((resolve) => setTimeout(resolve, 150));

          const imageBuffer = await page.screenshot({ type: 'jpeg', quality: 85 });
          const uploadResult = await uploadFromBuffer(imageBuffer);
          imageUrls[index] = uploadResult.secure_url;
        } finally {
          await page.close();
        }
      })
    );

    return res.status(200).json({
      status: 'success',
      success: true,
      count: imageUrls.length,
      images: imageUrls
    });

  } catch (error) {
    console.error('Render Error:', error);
    return res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
};