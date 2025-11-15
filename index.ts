import puppeteer, { Browser, Page } from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import * as readline from 'readline';

const TOR_PROXY_HOST = '127.0.0.1';
const TOR_PROXY_PORT = 9150;
const RESULTS_DIR = path.join(__dirname, 'results');

if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR);
}

interface OfferData {
    title: string;
    description: string;
    price: string;
}

interface ParsedOffer {
    link: string;
    ru: OfferData;
    en: OfferData;
}

function findTorBrowserPath(): string {
    const platform = os.platform();
    const possiblePaths: string[] = [];

    if (platform === 'win32') {
        const drives = ['C:', 'D:', 'E:'];
        const locations = [
            '\\Users\\' + os.userInfo().username + '\\Desktop\\Tor Browser\\Browser\\firefox.exe',
            '\\Program Files\\Tor Browser\\Browser\\firefox.exe',
            '\\Program Files (x86)\\Tor Browser\\Browser\\firefox.exe',
        ];
        drives.forEach((drive) => {
            locations.forEach((loc) => possiblePaths.push(drive + loc));
        });
    } else if (platform === 'darwin') {
        possiblePaths.push('/Applications/Tor Browser.app/Contents/MacOS/firefox');
    } else {
        possiblePaths.push('/usr/bin/tor-browser');
        possiblePaths.push(
            path.join(
                os.homedir(),
                '.local/share/torbrowser/tbb/x86_64/tor-browser/Browser/firefox'
            )
        );
    }

    for (const torPath of possiblePaths) {
        if (fs.existsSync(torPath)) {
            console.log(`Tor Browser found: ${torPath}`);
            return torPath;
        }
    }
    throw new Error('Tor Browser not found');
}

async function startTorBrowser(): Promise<any> {
    return new Promise((resolve, reject) => {
        try {
            const torPath = findTorBrowserPath();
            console.log('Starting Tor Browser...');
            const torProcess = exec(`"${torPath}"`, (error) => {
                if (error && error.code !== 0) {
                    console.error('Tor Browser error:', error);
                }
            });
            setTimeout(() => {
                console.log('Tor Browser started');
                resolve(torProcess);
            }, 8000);
        } catch (error) {
            reject(error);
        }
    });
}

async function checkTorConnection(): Promise<boolean> {
    try {
        const agent = new SocksProxyAgent(`socks5://${TOR_PROXY_HOST}:${TOR_PROXY_PORT}`);
        console.log('Checking Tor...');
        const response = await axios.get('https://check.torproject.org/api/ip', {
            httpAgent: agent,
            httpsAgent: agent,
            timeout: 10000,
        });
        if (response.data?.IsTor === true) {
            console.log('Tor OK! IP:', response.data.IP);
            return true;
        }
        return false;
    } catch (error: any) {
        console.error('Tor check error:', error.message);
        return false;
    }
}

async function clearPageData(page: Page) {
    // Очищаем все cookies
    const cookies = await page.cookies();
    if (cookies.length > 0) {
        await page.deleteCookie(...cookies);
    }

    // Очищаем localStorage и sessionStorage при загрузке новой страницы
    await page.evaluateOnNewDocument(() => {
        localStorage.clear();
        sessionStorage.clear();
    });
}

async function setLanguageAndCurrency(
    page: Page,
    language: 'ru' | 'en',
    currency: 'RUB' | 'EUR' | 'USD' = 'EUR'
) {
    try {
        console.log(`  Setting language to ${language.toUpperCase()} and currency to ${currency}`);

        // Ждем загрузки дропдаунов
        await page.waitForSelector('li.dropdown', { timeout: 5000 });

        // === РАБОТА С ЯЗЫКОМ ===
        // Находим и кликаем на дропдаун языка (первый dropdown)
        const langDropdownClicked = await page.evaluate(() => {
            const dropdowns = document.querySelectorAll('li.dropdown');
            for (const dropdown of dropdowns) {
                const toggle = dropdown.querySelector('.dropdown-toggle');
                if (toggle) {
                    const text = toggle.textContent || '';
                    // Первый дропдаун обычно для языка
                    if (
                        text.includes('По-русски') ||
                        text.includes('English') ||
                        dropdown.querySelector('.menu-icon-lang-ru') ||
                        dropdown.querySelector('.menu-icon-lang-uk')
                    ) {
                        (toggle as HTMLElement).click();
                        return true;
                    }
                }
            }
            return false;
        });

        if (langDropdownClicked) {
            await new Promise((resolve) => setTimeout(resolve, 500));

            // Выбираем нужный язык из выпадающего меню
            const languageSet = await page.evaluate((targetLang) => {
                const dropdownMenu = document.querySelector('li.dropdown.open .dropdown-menu');
                if (!dropdownMenu) return false;

                const links = dropdownMenu.querySelectorAll('a');
                for (const link of links) {
                    const href = link.getAttribute('href') || '';
                    const text = link.textContent?.trim() || '';

                    // Для английского языка
                    if (targetLang === 'en') {
                        if (href.includes('/en/') || text.includes('English')) {
                            (link as HTMLElement).click();
                            return true;
                        }
                    }
                    // Для русского языка
                    else if (targetLang === 'ru') {
                        if (
                            !href.includes('/en/') &&
                            (href === '/' || text.includes('По-русски'))
                        ) {
                            (link as HTMLElement).click();
                            return true;
                        }
                    }
                }
                return false;
            }, language);

            if (languageSet) {
                console.log(`  ✓ Language set to ${language.toUpperCase()}`);
                // Ждем перезагрузки страницы после смены языка
                await page
                    .waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 })
                    .catch(() => {});
            }
        }

        // === РАБОТА С ВАЛЮТОЙ ===
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Находим и кликаем на дропдаун валюты (второй dropdown)
        const currencyDropdownClicked = await page.evaluate(() => {
            const dropdowns = document.querySelectorAll('li.dropdown');
            for (const dropdown of dropdowns) {
                const toggle = dropdown.querySelector('.dropdown-toggle');
                if (toggle) {
                    const text = toggle.textContent || '';
                    // Проверяем что это дропдаун с валютой
                    if (
                        text.includes('€') ||
                        text.includes('$') ||
                        text.includes('₽') ||
                        text.includes('Евро') ||
                        text.includes('Рубль') ||
                        dropdown.querySelector('.user-cy-switcher')
                    ) {
                        (toggle as HTMLElement).click();
                        return true;
                    }
                }
            }
            return false;
        });

        if (currencyDropdownClicked) {
            await new Promise((resolve) => setTimeout(resolve, 500));

            // Выбираем нужную валюту
            const currencySet = await page.evaluate((targetCurrency) => {
                const dropdownMenu = document.querySelector('li.dropdown.open .dropdown-menu');
                if (!dropdownMenu) return false;

                const links = dropdownMenu.querySelectorAll('a');
                for (const link of links) {
                    const text = link.textContent?.trim() || '';

                    if (
                        (targetCurrency === 'EUR' && text.includes('Евро')) ||
                        (targetCurrency === 'USD' && text.includes('Доллар')) ||
                        (targetCurrency === 'RUB' && text.includes('Рубль'))
                    ) {
                        (link as HTMLElement).click();
                        return true;
                    }
                }
                return false;
            }, currency);

            if (currencySet) {
                console.log(`  ✓ Currency set to ${currency}`);
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }
    } catch (error: any) {
        console.log(`  ⚠ Could not set language/currency: ${error.message}`);
    }
}

// Альтернативный метод через прямые селекторы
async function setLanguageAndCurrencyDirect(
    page: Page,
    language: 'ru' | 'en',
    currency: 'RUB' | 'EUR' | 'USD' = 'EUR'
) {
    try {
        // Для языка - кликаем напрямую по ссылке в дропдауне
        await page.evaluate((lang) => {
            // Находим все дропдауны
            const dropdowns = document.querySelectorAll('li.dropdown');

            // Первый дропдаун - язык
            if (dropdowns[0]) {
                const toggle = dropdowns[0].querySelector('.dropdown-toggle') as HTMLElement;
                if (toggle) toggle.click();

                setTimeout(() => {
                    const menu = dropdowns[0].querySelector('.dropdown-menu');
                    if (menu) {
                        const links = menu.querySelectorAll('a');
                        links.forEach((link) => {
                            const href = link.getAttribute('href') || '';
                            if (lang === 'en' && href.includes('/en/')) {
                                (link as HTMLElement).click();
                            } else if (lang === 'ru' && !href.includes('/en/')) {
                                (link as HTMLElement).click();
                            }
                        });
                    }
                }, 300);
            }
        }, language);

        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Для валюты
        await page.evaluate((curr) => {
            const dropdowns = document.querySelectorAll('li.dropdown');

            // Второй дропдаун - валюта (или ищем по классу)
            const currencyDropdown = Array.from(dropdowns).find(
                (d) =>
                    d.innerHTML.includes('user-cy-switcher') ||
                    d.textContent?.includes('€') ||
                    d.textContent?.includes('Евро')
            );

            if (currencyDropdown) {
                const toggle = currencyDropdown.querySelector('.dropdown-toggle') as HTMLElement;
                if (toggle) toggle.click();

                setTimeout(() => {
                    const menu = currencyDropdown.querySelector('.dropdown-menu');
                    if (menu) {
                        const links = menu.querySelectorAll('a');
                        links.forEach((link) => {
                            const text = link.textContent || '';
                            if (
                                (curr === 'EUR' && text.includes('Евро')) ||
                                (curr === 'USD' && text.includes('Доллар')) ||
                                (curr === 'RUB' && text.includes('Рубль'))
                            ) {
                                (link as HTMLElement).click();
                            }
                        });
                    }
                }, 300);
            }
        }, currency);

        await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error: any) {
        console.log(`  ⚠ Direct method failed: ${error.message}`);
    }
}

async function parseOfferLocale(
    page: Page,
    offerId: string,
    locale: 'ru' | 'en',
    currency: 'RUB' | 'EUR' | 'USD' = 'EUR'
): Promise<OfferData> {
    // Очищаем данные
    await clearPageData(page);

    // Переходим на страницу
    const url = `https://funpay.com/lots/offer?id=${offerId}`;
    console.log(`  [${locale.toUpperCase()}] ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Устанавливаем язык и валюту
    await setLanguageAndCurrency(page, locale, currency);

    // Ждем обновления контента
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Проверяем что язык установился правильно
    const isCorrectLanguage = await page.evaluate((expectedLang) => {
        const bodyText = document.body.textContent || '';
        if (expectedLang === 'en') {
            return bodyText.includes('Description') || bodyText.includes('Price');
        } else {
            return bodyText.includes('Описание') || bodyText.includes('Цена');
        }
    }, locale);

    if (!isCorrectLanguage) {
        console.log(`  Retrying language switch with direct method...`);
        await setLanguageAndCurrencyDirect(page, locale, currency);
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // Обработка select если есть
    try {
        const selectExists = await page.$('select');
        if (selectExists) {
            await page.select(
                'select',
                await page.evaluate(() => {
                    const select = document.querySelector('select');
                    if (!select) return '';
                    const options = select.querySelectorAll('option');
                    for (let opt of options) {
                        if (opt.value && opt.value !== '') return opt.value;
                    }
                    return '';
                })
            );
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    } catch (e) {}

    // Парсим данные
    const data = await page.evaluate(() => {
        const result = { title: '', description: '', price: '' };

        const paramItems = document.querySelectorAll('.param-item');
        paramItems.forEach((item) => {
            const h5 = item.querySelector('h5');
            const div = item.querySelector('div');
            if (h5 && div) {
                const titleText = h5.textContent?.trim().toLowerCase() || '';
                const content = div.textContent?.trim() || '';

                if (
                    titleText.includes('short description') ||
                    titleText.includes('краткое описание')
                ) {
                    if (!result.title) result.title = content;
                } else if (titleText.includes('range') || titleText.includes('диапазон')) {
                    if (!result.title) result.title = content;
                } else if (
                    titleText.includes('detailed description') ||
                    titleText.includes('full description') ||
                    titleText.includes('подробное описание') ||
                    titleText.includes('полное описание')
                ) {
                    result.description = content;
                }
            }
        });

        // Ищем цену
        const allElements = document.querySelectorAll('*');
        for (let el of allElements) {
            const text = el.textContent?.trim() || '';
            if (text.match(/^(от|from)\s+[\d.,]+\s*[₽€$]/i)) {
                result.price = text;
                break;
            }
        }
        return result;
    });

    // Форматируем данные
    data.description = data.description.replace(/\s+/g, ' ').trim();
    if (data.price) {
        const priceMatch = data.price.match(/[\d.,]+\s*[₽€$]/);
        if (priceMatch) data.price = priceMatch[0];
    }

    console.log(`  [${locale.toUpperCase()}] ✓ ${data.title.substring(0, 40)} | ${data.price}`);
    return data;
}

async function parseOffer(pageRu: Page, pageEn: Page, offerId: string): Promise<ParsedOffer> {
    console.log(`\n=== Offer ID: ${offerId} ===`);

    // Парсим русскую версию с рублями
    const ru = await parseOfferLocale(pageRu, offerId, 'ru', 'RUB');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Парсим английскую версию с евро
    const en = await parseOfferLocale(pageEn, offerId, 'en', 'EUR');

    return {
        link: `https://funpay.com/lots/offer?id=${offerId}`,
        ru,
        en,
    };
}

async function parseFunpay(url: string, categoryFilter: string | null = null) {
    let browserRu: Browser | null = null;
    let browserEn: Browser | null = null;
    let torProcess: any = null;

    try {
        torProcess = await startTorBrowser();
        const isTorConnected = await checkTorConnection();
        if (!isTorConnected) throw new Error('Tor connection failed');

        console.log('Launching 2 browsers (RU + EN)...');

        // Браузер для РУССКОГО с опциями для чистого состояния
        browserRu = await puppeteer.launch({
            headless: false,
            args: [
                `--proxy-server=socks5://${TOR_PROXY_HOST}:${TOR_PROXY_PORT}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials',
                '--disable-web-security',
                '--disable-features=BlockInsecurePrivateNetworkRequests',
                '--disable-features=OutOfBlinkCors',
                '--incognito',
            ],
        });

        // Браузер для АНГЛИЙСКОГО с опциями для чистого состояния
        browserEn = await puppeteer.launch({
            headless: false,
            args: [
                `--proxy-server=socks5://${TOR_PROXY_HOST}:${TOR_PROXY_PORT}`,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials',
                '--disable-web-security',
                '--disable-features=BlockInsecurePrivateNetworkRequests',
                '--disable-features=OutOfBlinkCors',
                '--incognito',
            ],
        });

        const pageRu = await browserRu.newPage();
        await pageRu.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

        // Очищаем данные для русской страницы
        await clearPageData(pageRu);
        await pageRu.setExtraHTTPHeaders({
            'Accept-Language': 'ru-RU,ru;q=0.9',
        });

        const pageEn = await browserEn.newPage();
        await pageEn.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

        // Очищаем данные для английской страницы
        await clearPageData(pageEn);
        await pageEn.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
        });

        // RU версия
        const urlRu = url.replace('/en/users/', '/users/');
        console.log(`[RU Browser] Loading: ${urlRu}`);
        await pageRu.goto(urlRu, { waitUntil: 'networkidle2', timeout: 60000 });

        // EN версия
        const urlEn = url.replace('/users/', '/en/users/');
        console.log(`[EN Browser] Loading: ${urlEn}`);
        await pageEn.goto(urlEn, { waitUntil: 'networkidle2', timeout: 60000 });

        // Собираем офферы с русской страницы
        const offerData = await pageRu.evaluate((filter: string | null) => {
            const data = { offerIds: [] as string[], availableCategories: [] as string[] };
            const offerBlocks = document.querySelectorAll('.offer');

            offerBlocks.forEach((block) => {
                const titleElement = block.querySelector('.offer-list-title h3 a');
                if (!titleElement) return;

                const categoryName = titleElement.textContent?.trim() || '';
                data.availableCategories.push(categoryName);

                if (filter && !categoryName.toLowerCase().includes(filter.toLowerCase())) return;

                const offerItems = block.querySelectorAll('.tc-item');
                offerItems.forEach((item) => {
                    const href = item.getAttribute('href') || '';
                    const match = href.match(/id=(\d+)/);
                    if (match) data.offerIds.push(match[1]);
                });
            });
            return data;
        }, categoryFilter);

        if (offerData.offerIds.length === 0) {
            console.log('No offers found!');
            console.log('Available categories:', offerData.availableCategories.join(', '));
            return { success: false };
        }

        console.log(`Found ${offerData.offerIds.length} offers`);
        console.log('Starting to parse offers with language and currency switching...\n');

        const parsedOffers: ParsedOffer[] = [];
        for (let i = 0; i < offerData.offerIds.length; i++) {
            console.log(`[${i + 1}/${offerData.offerIds.length}]`);
            const offer = await parseOffer(pageRu, pageEn, offerData.offerIds[i]);
            parsedOffers.push(offer);

            // Задержка между офферами
            if (i < offerData.offerIds.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, 1500));
            }
        }

        // Сохраняем результаты
        const timestamp = new Date().toISOString().split('T')[0];
        const category = categoryFilter || 'all';
        const fileName = `Parser_${category}_${timestamp}.json`;
        const filePath = path.join(RESULTS_DIR, fileName);

        fs.writeFileSync(filePath, JSON.stringify(parsedOffers, null, 2), 'utf-8');
        console.log(`\n✅ Results saved to: ${filePath}`);
        console.log(`Total offers parsed: ${parsedOffers.length}`);

        return { success: true, filePath, count: parsedOffers.length };
    } catch (error: any) {
        console.error('Error during parsing:', error.message);
        return { success: false, error: error.message };
    } finally {
        console.log('\nCleaning up...');
        if (browserRu) await browserRu.close();
        if (browserEn) await browserEn.close();
        if (torProcess) {
            torProcess.kill();
            console.log('Tor Browser closed');
        }
    }
}

// Интерактивный интерфейс командной строки
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function prompt() {
    rl.question('\nEnter FunPay profile URL (or "exit" to quit): ', async (url) => {
        if (url.toLowerCase() === 'exit') {
            console.log('Goodbye!');
            rl.close();
            return;
        }

        if (!url.includes('funpay.com/users/') && !url.includes('funpay.com/en/users/')) {
            console.log('❌ Invalid URL! Please provide a valid FunPay profile URL.');
            console.log('Example: https://funpay.com/users/12345678/');
            prompt();
            return;
        }

        rl.question('Category filter (press Enter for all categories): ', async (category) => {
            const filter = category.trim() || null;

            console.log('\n📊 Starting parser...');
            console.log(`URL: ${url}`);
            console.log(`Category filter: ${filter || 'All categories'}`);
            console.log('-------------------\n');

            const result = await parseFunpay(url, filter);

            if (result.success) {
                console.log(`\n✅ Parsing completed successfully!`);
                console.log(`📁 File: ${result.filePath}`);
                console.log(`📊 Total offers: ${result.count}`);
            } else {
                console.log(`\n❌ Parsing failed!`);
                if (result.error) {
                    console.log(`Error: ${result.error}`);
                }
            }

            rl.question('\nDo you want to parse another profile? (y/n): ', (answer) => {
                if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
                    prompt();
                } else {
                    console.log('Goodbye!');
                    rl.close();
                }
            });
        });
    });
}

// Запуск программы
console.log('=================================');
console.log('   FunPay Parser (RU/EN) v2.0   ');
console.log('=================================');
console.log('This parser extracts offers in both Russian and English');
console.log('with automatic language and currency switching.\n');

prompt();
