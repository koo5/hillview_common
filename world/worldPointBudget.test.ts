import {expect,test} from 'vitest';
import {worldPointMiB,worldBudgetPoints} from './worldPointBudget';
test('world geometry budget keeps the old default and offers explicit larger capacities',()=>{
 expect(worldPointMiB(null)).toBe(64);expect(worldBudgetPoints(64)).toBe(2796202);
 expect(worldPointMiB('128')).toBe(128);expect(worldBudgetPoints(128)).toBe(5592405);
 for(const value of ['', 'NaN','Infinity','0','64.5','2048','-16','abc'])expect(()=>worldPointMiB(value)).toThrow('pointMiB');
});

test('safe view overrides stale high URLs/preferences and creates a real recovery link',async()=>{
 const {worldBudgetChoice,safeWorldBudgetUrl}=await import('./worldPointBudget');
 const url=new URL('https://test/recon/panel/world?pointMiB=1024&resolution=full&eye=1,2,3');
 const safe=new URL(safeWorldBudgetUrl(url));
 expect(worldBudgetChoice(safe.searchParams,'1024')).toEqual({mib:16,reset:true});
 expect(safe.searchParams.get('resolution')).toBe('full');expect(safe.searchParams.get('eye')).toBe('1,2,3');
 expect(worldBudgetChoice(new URLSearchParams('safeBudget=1&pointMiB=garbage'),'broken')).toEqual({mib:16,reset:true});
});
