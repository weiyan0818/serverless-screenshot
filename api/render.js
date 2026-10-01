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

const escapeHtmlAttr = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * 依 style_key 產生卡片圖片 HTML。無 image_url 時回傳空字串，維持純文字排版。
 */
const buildStyledImageHtml = (styleKey, imageUrl) => {
  if (!imageUrl) return '';

  const src = escapeHtmlAttr(imageUrl);
  const key = String(styleKey || '').toLowerCase();

  switch (key) {
    case 'minimalist':
      return `
        <div class="card-image card-image--minimalist" style="border: 2px solid #000; padding: 8px; background: #FFF; box-sizing: border-box;">
          <img src="${src}" alt="" style="display: block; width: 100%; max-height: 380px; object-fit: cover;" />
        </div>
      `;
    case 'glassmorphism':
      return `
        <div class="card-image card-image--glassmorphism" style="border-radius: 20px; border: 1px solid rgba(255, 255, 255, 0.3); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); overflow: hidden; box-sizing: border-box;">
          <img src="${src}" alt="" style="display: block; width: 100%; max-height: 360px; object-fit: cover; border-radius: 20px;" />
        </div>
      `;
    case 'memo_ios':
      return `
        <div class="card-image card-image--memo-ios" style="margin: 12px 0; box-sizing: border-box;">
          <img src="${src}" alt="" style="display: block; width: 100%; max-height: 350px; object-fit: cover; border-radius: 16px; box-shadow: 0 4px 15px rgba(0,0,0,0.08);" />
        </div>
      `;
    case 'notion_notes':
      return `
        <figure class="card-image card-image--notion-notes" style="margin: 10px 0; box-sizing: border-box;">
          <img src="${src}" alt="" style="display: block; width: 100%; max-height: 340px; object-fit: cover; border: 1px solid #E9E9E7; border-radius: 8px;" />
          <figcaption class="card-image__caption" style="margin-top: 6px; min-height: 1em; color: #787774; font-size: 12px; line-height: 1.4;"></figcaption>
        </figure>
      `;
    default:
      return `
        <div class="card-image" style="margin: 12px 0; box-sizing: border-box;">
          <img src="${src}" alt="" style="display: block; width: 100%; max-height: 360px; object-fit: cover;" />
        </div>
      `;
  }
};

/**
 * 將風格化圖片插入既有卡片 HTML。
 * 優先替換 <!--CARD_IMAGE--> / {{CARD_IMAGE}}；否則插入常見內容容器開頭。
 */
const injectCardImage = (html, styleKey, imageUrl) => {
  if (!html || !imageUrl) return html;

  const imageBlock = buildStyledImageHtml(styleKey, imageUrl);
  if (!imageBlock) return html;

  if (/<!--\s*CARD_IMAGE\s*-->|{{\s*CARD_IMAGE\s*}}/i.test(html)) {
    return html.replace(/<!--\s*CARD_IMAGE\s*-->|{{\s*CARD_IMAGE\s*}}/gi, imageBlock);
  }

  const contentMatchers = [
    /(<(?:div|section|main)[^>]*class=["'][^"']*(?:card-content|card-body|content|page-body)[^"']*["'][^>]*>)/i,
    /(<(?:div|section)[^>]*class=["'][^"']*(?:card|page)[^"']*["'][^>]*>)/i,
  ];

  for (const matcher of contentMatchers) {
    if (matcher.test(html)) {
      return html.replace(matcher, `$1${imageBlock}`);
    }
  }

  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, `<body$1>${imageBlock}`);
  }

  return `${imageBlock}${html}`;
};

/**
 * 統一解析 htmlList / carousel_pages，產出最終要截圖的 HTML 陣列。
 * - htmlList 字串：維持原樣
 * - htmlList / carousel_pages 物件：若有 image_url 則依 style_key 插入圖片
 */
const resolveHtmlList = (body = {}) => {
  const styleKey = body.style_key || body.styleKey || '';
  const pages = Array.isArray(body.carousel_pages)
    ? body.carousel_pages
    : Array.isArray(body.htmlList)
      ? body.htmlList
      : null;

  if (!pages) return null;

  return pages.map((item) => {
    if (typeof item === 'string') {
      return item;
    }

    if (!item || typeof item !== 'object') {
      return '';
    }

    const html = item.html || item.content_html || item.contentHtml || '';
    const imageUrl = item.image_url || item.imageUrl || '';
    const itemStyle = item.style_key || item.styleKey || styleKey;

    return injectCardImage(html, itemStyle, imageUrl);
  }).filter((html) => typeof html === 'string' && html.length > 0);
};

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

const waitForFontsAndImages = async (page) => {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const images = Array.from(document.images || []);
    await Promise.all(
      images.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        });
      })
    );
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

  const htmlList = resolveHtmlList(req.body);

  if (!htmlList || htmlList.length === 0) {
    return res.status(400).json({ error: '請提供有效的 htmlList 或 carousel_pages 陣列' });
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
          await waitForFontsAndImages(page);
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