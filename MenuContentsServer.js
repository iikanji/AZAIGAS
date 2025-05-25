/**
 * Returns all menu data from all three tabs in the menu spreadsheet.
 * Each tab's data is keyed by its name.
 */
function getMenuContents() {
    var ss = SpreadsheetApp.openById('1Ul70w5DZSUZA6jwMHZmb_T-I-MrD8BegCkhygYcGGhY');
    var sheets = ss.getSheets();
    var result = {};
    sheets.forEach(function(sheet) {
      var data = sheet.getDataRange().getValues();
      var headers = data.shift();
      result[sheet.getName()] = data.map(function(row) {
        var obj = {};
        headers.forEach(function(header, i) {
          obj[header] = row[i];
        });
        return obj;
      });
    });
    return result;
  }
  