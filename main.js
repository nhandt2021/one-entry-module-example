import axios from 'axios'
import pLimit from 'p-limit'

const {
    API_KEY = 'API key for site currencyfreaks.com',
    DEVELOPER_API_HOST = 'https://your_project.oneentry.cloud',
    BASE_CURRENCY_LANG = 'en_US',
    BASE_CURRENCY = 'USD',
    SYNC_CURRENCY_LANG = 'fr_FR',
    SYNC_CURRENCY = 'EUR',
    ATTRIBUTE_SET_MARKER = 'boots',
    PRICE_ATTRIBUTE_MARKER = 'price_boots',
    DEVELOPER_LOGIN = 'developer_admin',
    DEVELOPER_PASSWORD = '1-1',
    UPDATE_EVERY = 3 * 60 * 60 * 1000,
} = process.env

const API_URL = `https://api.currencyfreaks.com/v2.0/rates/latest?apikey=${API_KEY}`

const api = axios.create({
    baseURL: DEVELOPER_API_HOST + '/api/developer',
})

let {
    data: { accessToken, refreshToken },
} = await api.post('auth/login', {
    login: DEVELOPER_LOGIN,
    password: DEVELOPER_PASSWORD,
})

api.interceptors.request.use((config) => {
    config.headers.setAuthorization(`Bearer ${accessToken}`)

    return config
}, Promise.reject)

api.interceptors.response.use(
    (response) => response,
    async (error) => {
        const config = error?.config

        if (error?.response?.status === 401 && !config?.sent) {
            config.sent = true

            const { data: pair } = await axios.post(
                `${DEVELOPER_API_HOST}/auth/refresh`,
                {
                    refreshToken,
                }
            )

            refreshToken = pair.refreshToken

            config.headers = {
                ...config.headers,
                authorization: `Bearer ${pair.accessToken}`,
            }

            return axios(config)
        }
        return Promise.reject(error)
    }
)

const { data: attributeSet } = await api.get(
    `attributes-sets/marker/${ATTRIBUTE_SET_MARKER}`
)

const attributeSchema = Object.values(attributeSet.schema).find(
    ({ identifier }) => identifier === PRICE_ATTRIBUTE_MARKER
)

if (!attributeSchema) {
    throw new Error('Unable to find attribute to change')
}

const ATTRIBUTE_INTERNAL_ID = `${attributeSchema.type}_id${attributeSchema.id}`

const limit = pLimit(8)

let offset = 0
let total = 0
let rate = await fetchRate()

let updates = []

while (true) {
    if (offset > total) {
        await Promise.all(updates)
        console.log(`${updates.length} products updated`)
        offset = 0
        await new Promise((r) => setTimeout(r, UPDATE_EVERY))
        rate = await fetchRate()
    }

    const { data } = await api.post(
        `products/all?langCode=${BASE_CURRENCY_LANG}&limit=30&offset=${offset}`,
        []
    )

    total = data.total

    for (const product of data.items) {
        if (product.attributeSetId !== attributeSet.id) {
            continue
        }

        const baseCurrencyAttributes =
            product.attributesSets[BASE_CURRENCY_LANG] ?? {}
        const syncCurrencyAttributes =
            structuredClone(product.attributesSets[SYNC_CURRENCY_LANG]) ?? {}

        const newPrice =
            parseFloat(baseCurrencyAttributes[ATTRIBUTE_INTERNAL_ID] ?? 0) *
            rate
        console.log('New price: ', newPrice)
        const stringPrice = newPrice.toFixed(2)

        if (syncCurrencyAttributes[ATTRIBUTE_INTERNAL_ID] === stringPrice) {
            continue
        }

        syncCurrencyAttributes[ATTRIBUTE_INTERNAL_ID] = stringPrice

        updates.push(
            limit(() =>
                api.put(`products/${product.id}`, {
                    attributesSets: {
                        ...product.attributesSets,
                        [SYNC_CURRENCY_LANG]: syncCurrencyAttributes,
                    },
                    version: product.version + 1,
                })
            )
        )
    }

    offset += 30
}

async function fetchRate() {
    console.log('Updating rates')
    try {
        const response = await axios.get(API_URL)
        const { rates = {} } = response.data
        if (!rates) {
            console.log('No data available for exchange rates.')
            process.exit(1)
        }

        return rates[BASE_CURRENCY] * rates[SYNC_CURRENCY]
    } catch (error) {
        console.error('Error fetching exchange rates:', error)
        process.exit(1)
    }
}
