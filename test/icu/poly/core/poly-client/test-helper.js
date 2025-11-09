import { PolyClient } from '../../../../../src/icu/poly/core/PolyClient.js';

// 共享的测试常量
export const tokenIdA = '34867255137037269425915341043331567102849891703547876866504427548331529932296';
export const tokenIdB = '24522672209353958941098640603807044129208567881036115692375517880925138856817';

// 创建 PolyClient 实例的辅助函数
export function createPolyClient() {
    return new PolyClient();
}

